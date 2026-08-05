import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import type { AgentTool } from '@/agent-harness';
import {
  BGSM_AGENT_TOOL_CATALOG,
  BgsmAgentToolRegistry,
  createBgsmAgentToolRegistry,
  getBgsmAgentToolDefinition,
} from '@/bgsm-agent';

describe('Cubby tool registry', () => {
  it('owns one stable definition for every product tool', () => {
    const names = BGSM_AGENT_TOOL_CATALOG.map((definition) => definition.name);

    assert.equal(names.length, 14);
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual(names, [
      'request_full_library_organization',
      'start_full_library_analysis',
      'list_tags',
      'list_stars',
      'get_star',
      'search_stars',
      'inspect_tag',
      'assign_repo_tags',
      'remove_repo_tags',
      'delete_tags_everywhere',
      'list_repository_files',
      'search_repository_code',
      'read_repository_file',
      'read_repository_notes',
    ]);
    assert.equal(getBgsmAgentToolDefinition('search_repository_code')?.capability, 'repository_code');
    assert.equal(getBgsmAgentToolDefinition('search_repository_code')?.visibility, 'task');
    assert.equal(getBgsmAgentToolDefinition('delete_tags_everywhere')?.writePolicy, 'delete_tags');
    assert.equal(getBgsmAgentToolDefinition('not-a-tool'), undefined);
  });

  it('projects an immutable active subset while retaining the complete catalog', () => {
    const base = createBgsmAgentToolRegistry({ repositoryScope: ['owner/repo'] });
    const all = createBgsmAgentToolRegistry({
      repositoryScope: ['owner/repo'],
      enableOrganizeLibraryHandoff: true,
      requestOrganizeLibraryHandoff: () => ({ status: 'accepted' }),
      enableRepositoryCodeSearch: true,
      enableRepositoryNotes: true,
    });

    assert.deepEqual(base.getActiveToolNames(), [
      'list_tags',
      'list_stars',
      'get_star',
      'search_stars',
      'inspect_tag',
      'assign_repo_tags',
      'remove_repo_tags',
      'delete_tags_everywhere',
    ]);
    assert.deepEqual(all.getActiveToolNames(), BGSM_AGENT_TOOL_CATALOG.map(({ name }) => name));
    assert.equal(all.getAllDefinitions(), BGSM_AGENT_TOOL_CATALOG);
    assert.equal(all.getActiveTool('read_repository_notes')?.name, 'read_repository_notes');
    assert.equal(base.getActiveTool('read_repository_notes'), undefined);
    assert.throws(
      () => (base.getActiveTools() as AgentTool[]).push(fakeTool('list_tags')),
      TypeError,
    );

    const mutableInput = fakeTool('list_tags');
    const defensive = new BgsmAgentToolRegistry([mutableInput]);
    const activeSnapshot = defensive.getActiveTools()[0];
    assert.notEqual(activeSnapshot, mutableInput);
    assert.throws(
      () => Object.assign(activeSnapshot, { name: 'get_star', risk: 'write' }),
      TypeError,
    );
    Object.assign(mutableInput, { name: 'get_star', risk: 'write' });
    assert.deepEqual(defensive.getActiveToolNames(), ['list_tags']);
    assert.equal(defensive.getActiveTools()[0]?.risk, 'read');

    const readOnly = createBgsmAgentToolRegistry({
      repositoryScope: ['owner/repo'],
      enableTagWrites: false,
    });
    assert.equal(
      readOnly.getActiveTools().some(({ risk }) => risk === 'write'),
      false,
    );
  });

  it('activates only the capability groups enabled for the current turn', () => {
    const localReadNames = [
      'list_tags',
      'list_stars',
      'get_star',
      'search_stars',
      'inspect_tag',
    ];
    const code = createBgsmAgentToolRegistry({
      repositoryScope: ['owner/repo'],
      enableTagWrites: false,
      enableRepositoryCodeSearch: true,
    });
    const notes = createBgsmAgentToolRegistry({
      repositoryScope: ['owner/repo'],
      enableTagWrites: false,
      enableRepositoryNotes: true,
    });
    const organization = createBgsmAgentToolRegistry({
      repositoryScope: ['owner/repo'],
      enableTagWrites: false,
      enableOrganizeLibraryHandoff: true,
      requestOrganizeLibraryHandoff: () => ({ status: 'accepted' }),
    });

    assert.deepEqual(code.getActiveToolNames(), [
      ...localReadNames,
      'list_repository_files',
      'search_repository_code',
      'read_repository_file',
    ]);
    assert.deepEqual(notes.getActiveToolNames(), [
      ...localReadNames,
      'read_repository_notes',
    ]);
    assert.deepEqual(organization.getActiveToolNames(), [
      'request_full_library_organization',
      'start_full_library_analysis',
      ...localReadNames,
    ]);
    assert.throws(
      () => createBgsmAgentToolRegistry({
        repositoryScope: ['owner/repo'],
        enableOrganizeLibraryHandoff: true,
      }),
      /requires an execution callback/u,
    );
  });

  it('keeps the UI-facing catalog free of runtime imports', () => {
    const source = readFileSync(
      new URL('../../src/bgsm-agent/tool-catalog.ts', import.meta.url),
      'utf8',
    );

    assert.doesNotMatch(source, /^\s*import\s+(?!type\b)/mu);
    assert.doesNotMatch(source, /\bimport\s*\(/u);
  });

  it('fails closed for unknown, duplicate, or metadata-inconsistent runtime tools', () => {
    assert.throws(
      () => new BgsmAgentToolRegistry([fakeTool('unknown')]),
      /Unknown Cubby tool/u,
    );
    assert.throws(
      () => new BgsmAgentToolRegistry([fakeTool('list_tags'), fakeTool('list_tags')]),
      /Duplicate Cubby tool/u,
    );
    assert.throws(
      () => new BgsmAgentToolRegistry([fakeTool('list_tags', 'write')]),
      /risk does not match/u,
    );
    assert.throws(
      () => new BgsmAgentToolRegistry([{
        ...fakeTool('request_full_library_organization', 'suggest'),
        requiresExclusiveEnvelope: false,
      }]),
      /exclusive-envelope contract does not match/u,
    );
  });
});

function fakeTool(
  name: string,
  risk: AgentTool['risk'] = 'read',
): AgentTool {
  return {
    name,
    description: name,
    risk,
    async execute() {},
  };
}
