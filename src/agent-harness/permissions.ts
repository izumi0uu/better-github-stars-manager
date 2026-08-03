import type { ModelToolCall } from './provider';
import type { AgentExecutableTool } from './tools';

export type PermissionDecision =
  | { type: 'allow' }
  | { type: 'deny'; reason: string }
  | { type: 'approval_required'; summary: string };

export type PermissionContext = {
  sessionId: string;
  toolCall: ModelToolCall;
};

export type PermissionEvaluator = (
  tool: AgentExecutableTool,
  args: unknown,
  context: PermissionContext,
) => PermissionDecision | Promise<PermissionDecision>;

export const defaultPermissionEvaluator: PermissionEvaluator = (tool) => {
  if (tool.risk === 'write') {
    return {
      type: 'approval_required',
      summary: `${tool.name} needs your review before changing tags.`,
    };
  }
  return { type: 'allow' };
};
