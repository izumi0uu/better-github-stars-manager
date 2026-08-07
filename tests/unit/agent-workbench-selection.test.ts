import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Agent workbench ownership and repository selection', () => {
  it('keeps controller ownership in the lazy host and preserves selected repository context', () => {
    const manager = readFileSync('src/ui/ManagerPanel.tsx', 'utf8');
    const host = readFileSync('src/ui/components/AgentHost.tsx', 'utf8');
    const panel = readFileSync('src/ui/components/AgentPanel.tsx', 'utf8');

    expect(manager).toContain("lazy(() => import('@/ui/components/AgentHost')");
    expect(manager).toMatch(/const openAgentPanel = \(\) => \{\s*setAgentHostMounted\(true\);\s*setAgentPanelOpen\(true\);\s*\};/u);
    expect(manager).not.toMatch(/openAgentPanel[\s\S]{0,140}setSelected\(null\)/u);
    expect(manager).toContain("kind: 'selected_repository' as const");
    expect(manager).toContain('selectedRepositoryIdHint: selected');
    expect(manager).toContain('chatCandidate={agentCandidate}');
    expect(host).toContain('const agent = useBgsmAgent(onDataChanged, chatCandidate);');
    expect(host).toContain('const workbench = useBgsmAgentWorkbench(onDataChanged, agent.sessionId, agent.sessionReady);');
    expect(panel).not.toContain('useBgsmAgent(');
    expect(panel).not.toContain('useBgsmAgentWorkbench(');
  });

  it('keeps deterministic Auto Tags separate from the Agent entry', () => {
    const toolbar = readFileSync('src/ui/components/Toolbar.tsx', 'utf8');
    expect(toolbar).toContain('onClick={() => onAutoAssignTags()}');
    expect(toolbar).toContain('onClick={() => onOpenAgent()}');
    expect(toolbar).not.toContain('Retry failed only');
  });
});
