import type {
  AgentMessage,
  AgentTool,
  PermissionEvaluator,
} from '@/agent-harness';

type ReadEvidence = {
  repositories: Set<string>;
  tags: Set<string>;
  repositoryTags: Set<string>;
};

const DIRECT_ASSIGNMENT_WRITE_CALL_LIMIT = 8;

export type BgsmTurnCapabilities = Readonly<{
  manualTagWritesForbidden: boolean;
  repositoryCodeSearch: boolean;
  repositoryNotes: boolean;
  repositoryCodeReadOnly?: boolean;
}>;

export function hasSuccessfulRepositoryCodeToolHistory(
  messages: readonly AgentMessage[],
): boolean {
  return messages.some((message) => (
    message.role === 'tool'
    && isRepositoryCodeTool(message.toolName)
    && isSuccessfulToolResult(message.content)
  ));
}

export function createBgsmTurnAuthorization(capabilities: BgsmTurnCapabilities): {
  wrapTools: (tools: AgentTool[]) => AgentTool[];
  permissions: PermissionEvaluator;
} {
  const evidence: ReadEvidence = {
    repositories: new Set(),
    tags: new Set(),
    repositoryTags: new Set(),
  };
  let remainingAssignmentWrites = DIRECT_ASSIGNMENT_WRITE_CALL_LIMIT;

  return {
    wrapTools(tools) {
      return tools.map((tool) => tool.risk === 'read' ? wrapReadTool(tool, evidence) : tool);
    },
    permissions(tool, args) {
      if (tool.name === 'read_repository_notes' && !capabilities.repositoryNotes) {
        return denyCurrentAuthorization();
      }
      if (isRepositoryCodeTool(tool.name) && !capabilities.repositoryCodeSearch) {
        return denyCurrentAuthorization();
      }
      if (tool.risk !== 'write') return { type: 'allow' };
      if (
        capabilities.repositoryCodeReadOnly
        || capabilities.manualTagWritesForbidden
      ) return denyCurrentAuthorization();
      const value = objectArgs(args);
      if (tool.name === 'assign_repo_tags') {
        const repository = stringArg(value, 'full_name');
        if (
          !evidence.repositories.has(normalize(repository)) ||
          remainingAssignmentWrites <= 0
        ) {
          return denyCurrentAuthorization();
        }
        remainingAssignmentWrites -= 1;
        return { type: 'allow' };
      }
      if (tool.name === 'remove_repo_tags') {
        const changes = arrayArg(value, 'changes');
        if (
          changes.length === 0
          || changes.some((rawChange) => {
            const change = objectArgs(rawChange);
            const repository = stringArg(change, 'full_name');
            const tags = stringArrayArg(change, 'tags');
            return !repository
              || tags.length === 0
              || !evidence.repositories.has(normalize(repository))
              || tags.some((tag) => !evidence.repositoryTags.has(pair(repository, tag)));
          })
        ) return denyCurrentAuthorization();
        return { type: 'allow' };
      }
      if (tool.name === 'delete_tags_everywhere') {
        const tags = stringArrayArg(value, 'tags');
        if (
          tags.length === 0
          || tags.some((tag) => !evidence.tags.has(normalize(tag)))
        ) return denyCurrentAuthorization();
        return { type: 'allow' };
      }
      return denyCurrentAuthorization();
    },
  };
}

function wrapReadTool(tool: AgentTool, evidence: ReadEvidence): AgentTool {
  return {
    ...tool,
    async execute(args, context) {
      const result = await tool.execute(args, context);
      recordReadEvidence(tool.name, result, evidence);
      return result;
    },
  };
}

function recordReadEvidence(toolName: string, result: unknown, evidence: ReadEvidence): void {
  const value = objectArgs(result);
  if (toolName === 'get_star') {
    recordRepositoryEvidence(value.star, evidence);
    return;
  }
  if (toolName === 'list_stars' || toolName === 'search_stars') {
    for (const star of arrayArg(value, 'stars')) {
      recordRepositoryEvidence(star, evidence);
    }
    return;
  }
  if (toolName === 'list_tags') {
    for (const tagRow of arrayArg(value, 'tags')) {
      const tag = optionalStringArg(objectArgs(tagRow), 'name');
      if (tag) evidence.tags.add(normalize(tag));
    }
    return;
  }
  if (toolName !== 'inspect_tag') return;
  const inspectedTag = optionalStringArg(value, 'tag');
  const repositories = arrayArg(value, 'repos');
  if (inspectedTag && repositories.length > 0) {
    evidence.tags.add(normalize(inspectedTag));
  }
  for (const repoRow of repositories) {
    const repo = objectArgs(repoRow);
    const repository = optionalStringArg(repo, 'full_name');
    if (!repository) continue;
    evidence.repositories.add(normalize(repository));
    if (inspectedTag) evidence.repositoryTags.add(pair(repository, inspectedTag));
    for (const tag of arrayArg(repo, 'tags')) {
      if (typeof tag === 'string') evidence.repositoryTags.add(pair(repository, tag));
    }
  }
}

function recordRepositoryEvidence(result: unknown, evidence: ReadEvidence): void {
  const repository = objectArgs(result);
  const fullName = optionalStringArg(repository, 'full_name');
  if (!fullName) return;
  evidence.repositories.add(normalize(fullName));
  for (const tag of stringArrayArg(repository, 'tags')) {
    evidence.repositoryTags.add(pair(fullName, tag));
  }
}

function isRepositoryCodeTool(toolName: string | undefined): boolean {
  return toolName === 'list_repository_files'
    || toolName === 'search_repository_code'
    || toolName === 'read_repository_file';
}

function isSuccessfulToolResult(content: string): boolean {
  try {
    const result: unknown = JSON.parse(content);
    return objectArgs(result).ok === true;
  } catch {
    return false;
  }
}


function denyCurrentAuthorization() {
  return {
    type: 'deny' as const,
    reason: 'This write is blocked by current-turn policy or lacks current-turn local repository evidence.',
  };
}

function pair(repository: string, tag: string): string {
  return `${normalize(repository)}\u0000${normalize(tag)}`;
}

function normalize(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function objectArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayArg(value: Record<string, unknown>, name: string): unknown[] {
  return Array.isArray(value[name]) ? value[name] : [];
}

function stringArrayArg(value: Record<string, unknown>, name: string): string[] {
  return arrayArg(value, name).filter((item): item is string => typeof item === 'string');
}

function stringArg(value: Record<string, unknown>, name: string): string {
  return optionalStringArg(value, name) ?? '';
}

function optionalStringArg(value: Record<string, unknown>, name: string): string | undefined {
  return typeof value[name] === 'string' ? value[name] : undefined;
}
