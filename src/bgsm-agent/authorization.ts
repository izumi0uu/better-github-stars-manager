import type {
  AgentMessage,
  AgentTool,
  PermissionEvaluator,
} from '@/agent-harness';
import {
  getBgsmAgentToolDefinition,
  isBgsmAgentToolCapability,
} from './tool-catalog';

type ReadEvidence = {
  repositories: Set<string>;
  tags: Set<string>;
  repositoryTags: Set<string>;
};

const DIRECT_ASSIGNMENT_WRITE_CALL_LIMIT = 8;

export type BgsmTurnAuthorizationOptions = Readonly<{
  repositoryCodeReadOnly?: boolean;
}>;

export function hasSuccessfulRepositoryCodeToolHistory(
  messages: readonly AgentMessage[],
): boolean {
  return messages.some((message) => (
    message.role === 'tool'
    && isBgsmAgentToolCapability(message.toolName, 'repository_code')
    && isSuccessfulToolResult(message.content)
  ));
}

export function createBgsmTurnAuthorization(
  options: BgsmTurnAuthorizationOptions = {},
): {
  wrapTools: (tools: AgentTool[]) => AgentTool[];
  permissions: PermissionEvaluator;
} {
  const evidence: ReadEvidence = {
    repositories: new Set(),
    tags: new Set(),
    repositoryTags: new Set(),
  };
  let remainingAssignmentWrites = DIRECT_ASSIGNMENT_WRITE_CALL_LIMIT;
  let repositoryCodeReadOnly = options.repositoryCodeReadOnly === true;

  return {
    wrapTools(tools) {
      return tools.map((tool) => tool.risk === 'read'
        ? wrapReadTool(tool, evidence, () => {
            repositoryCodeReadOnly = true;
          })
        : tool);
    },
    permissions(tool, args) {
      const definition = getBgsmAgentToolDefinition(tool.name);
      if (definition && tool.risk !== definition.risk) return denyCurrentAuthorization();
      if (
        definition?.capability === 'library_organization'
        && repositoryCodeReadOnly
      ) {
        return denyCurrentAuthorization();
      }
      if (tool.risk !== 'write') return { type: 'allow' };
      if (repositoryCodeReadOnly) return denyCurrentAuthorization();
      const value = objectArgs(args);
      if (definition?.writePolicy === 'assign_tags') {
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
      if (definition?.writePolicy === 'remove_tags') {
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
      if (definition?.writePolicy === 'delete_tags') {
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

function wrapReadTool(
  tool: AgentTool,
  evidence: ReadEvidence,
  enterRepositoryCodeReadOnly: () => void,
): AgentTool {
  return {
    ...tool,
    async execute(args, context) {
      const result = await tool.execute(args, context);
      if (isBgsmAgentToolCapability(tool.name, 'repository_code')) {
        enterRepositoryCodeReadOnly();
      }
      recordReadEvidence(tool.name, result, evidence);
      return result;
    },
  };
}

function recordReadEvidence(toolName: string, result: unknown, evidence: ReadEvidence): void {
  const value = objectArgs(result);
  const evidenceSource = getBgsmAgentToolDefinition(toolName)?.evidenceSource ?? 'none';
  if (evidenceSource === 'repository_from_star') {
    recordRepositoryEvidence(value.star, evidence);
    return;
  }
  if (evidenceSource === 'repositories_from_stars') {
    for (const star of arrayArg(value, 'stars')) {
      recordRepositoryEvidence(star, evidence);
    }
    return;
  }
  if (evidenceSource === 'tags_from_list') {
    for (const tagRow of arrayArg(value, 'tags')) {
      const tag = optionalStringArg(objectArgs(tagRow), 'name');
      if (tag) evidence.tags.add(normalize(tag));
    }
    return;
  }
  if (evidenceSource !== 'repository_tags_from_inspection') return;
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
