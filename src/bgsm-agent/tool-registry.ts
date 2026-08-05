import type { AgentTool } from '@/agent-harness';
import {
  BGSM_AGENT_TOOL_CATALOG,
  BGSM_AGENT_TOOL_REGISTRY_VERSION,
  getBgsmAgentToolDefinition,
  isBgsmAgentToolName,
  type BgsmAgentToolDefinition,
  type BgsmAgentToolName,
} from './tool-catalog';

export class BgsmAgentToolRegistry {
  readonly version = BGSM_AGENT_TOOL_REGISTRY_VERSION;
  private readonly activeTools: readonly AgentTool[];
  private readonly activeToolByName: ReadonlyMap<BgsmAgentToolName, AgentTool>;

  constructor(tools: readonly AgentTool[]) {
    const byName = new Map<BgsmAgentToolName, AgentTool>();
    const snapshots: AgentTool[] = [];
    for (const tool of tools) {
      const definition = getBgsmAgentToolDefinition(tool.name);
      if (!definition) throw new TypeError(`Unknown Cubby tool: ${tool.name}`);
      if (byName.has(definition.name)) {
        throw new TypeError(`Duplicate Cubby tool: ${definition.name}`);
      }
      if (tool.risk !== definition.risk) {
        throw new TypeError(`Cubby tool ${definition.name} risk does not match its registry definition.`);
      }
      if ((tool.requiresExclusiveEnvelope === true) !== definition.exclusiveEnvelope) {
        throw new TypeError(
          `Cubby tool ${definition.name} exclusive-envelope contract does not match its registry definition.`,
        );
      }
      const snapshot = Object.freeze({ ...tool });
      byName.set(definition.name, snapshot);
      snapshots.push(snapshot);
    }
    this.activeTools = Object.freeze(snapshots);
    this.activeToolByName = byName;
  }

  getAllDefinitions(): readonly BgsmAgentToolDefinition[] {
    return BGSM_AGENT_TOOL_CATALOG;
  }

  getActiveTools(): readonly AgentTool[] {
    return this.activeTools;
  }

  getActiveToolNames(): BgsmAgentToolName[] {
    return this.activeTools.map((tool) => tool.name as BgsmAgentToolName);
  }

  getActiveTool(name: string): AgentTool | undefined {
    return isBgsmAgentToolName(name) ? this.activeToolByName.get(name) : undefined;
  }

  getToolDefinition(name: string | undefined): BgsmAgentToolDefinition | undefined {
    return getBgsmAgentToolDefinition(name);
  }
}
