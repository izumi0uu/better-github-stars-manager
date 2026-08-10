import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import type { AgentTool } from '@/agent-harness';
import {
  BGSM_AGENT_TOOL_CATALOG,
  BgsmAgentToolRegistry,
  createBgsmAgentArtifactContinuationToolRegistry,
  createBgsmAgentArtifactEvidenceHandoff,
  createBgsmAgentToolRegistry,
  getBgsmAgentToolDefinition,
} from '@/bgsm-agent';
import type {
  AgentArtifactCoverageEvidence,
  BgsmAgentArtifactReader,
} from '@/bgsm-agent';
const unavailableArtifactReader: BgsmAgentArtifactReader = async () => {
  throw new Error('Reader should not execute in registry metadata tests.');
};

describe('Cubby tool registry', () => {
  it('owns one stable definition for every product tool', () => {
    const names = BGSM_AGENT_TOOL_CATALOG.map((definition) => definition.name);

    assert.equal(names.length, 15);
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
      'read_agent_artifact',
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
      artifactReader: unavailableArtifactReader,
      artifactEvidenceHandoff: createBgsmAgentArtifactEvidenceHandoff(),
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
    assert.equal(base.getActiveTool('read_agent_artifact'), undefined);
    assert.deepEqual(all.getActiveTool('read_agent_artifact')?.parameters, {
      type: 'object',
      properties: {
        artifactId: { type: 'string', minLength: 1, maxLength: 512 },
        cursor: { type: 'string', minLength: 1, maxLength: 2_048 },
        byteOffset: {
          type: 'integer',
          minimum: 0,
          maximum: 512 * 1024 * 1024,
        },
        search: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1, maxLength: 512 },
            fromByte: {
              type: 'integer',
              minimum: 0,
              maximum: 512 * 1024 * 1024,
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      required: ['artifactId'],
      additionalProperties: false,
    });
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

  it('builds a continuation registry with only the exact-authorized reader capability', async () => {
    let authorizedArguments: unknown;
    const registry = createBgsmAgentArtifactContinuationToolRegistry({
      artifactReader: unavailableArtifactReader,
      artifactEvidenceHandoff: createBgsmAgentArtifactEvidenceHandoff(),
      authorize(input) {
        authorizedArguments = input.arguments;
        return false;
      },
    });

    assert.deepEqual(registry.getActiveToolNames(), ['read_agent_artifact']);
    const reader = registry.getActiveTool('read_agent_artifact');
    assert.ok(reader);
    assert.equal(reader.requiresExclusiveEnvelope, true);
    const args = reader.validate?.({ artifactId: 'artifact:continuation' });
    await assert.rejects(
      () => reader.execute(args, {
        sessionId: 'session:continuation',
        callId: 'call:continuation',
      }),
      /not authorized/u,
    );
    assert.deepEqual(authorizedArguments, { artifactId: 'artifact:continuation' });
  });

  it('invokes the injected reader and keeps exact evidence outside model data', async () => {
    const evidenceHandoff = createBgsmAgentArtifactEvidenceHandoff();
    let readerArguments: unknown;
    const evidence: AgentArtifactCoverageEvidence = {
      schemaVersion: 1,
      artifactId: 'artifact:injected',
      artifactBytes: 4,
      artifactSha256: 'a'.repeat(43),
      integrityManifestSha256: 'b'.repeat(43),
      readKind: 'page',
      cursorSupplied: false,
      inputCursor: null,
      pageBytes: 4,
      nextCursor: null,
      touchedChunks: [{ index: 0, byteLength: 4, sha256: 'c'.repeat(43) }],
      touchedChunkCount: 1,
      touchedChunkBytes: 4,
      touchedChunkDigest: `atc:v1:${'d'.repeat(43)}`,
      integrityVerified: true,
    };
    const registry = createBgsmAgentToolRegistry({
      repositoryScope: ['owner/repo'],
      artifactEvidenceHandoff: evidenceHandoff,
      async artifactReader(input) {
        readerArguments = input.arguments;
        return {
          result: {
            artifactId: 'artifact:injected',
            content: 'data',
            contentType: 'application/json',
            byteLength: 4,
            totalBytes: 4,
            nextCursor: null,
          },
          evidence,
        };
      },
    });
    const reader = registry.getActiveTool('read_agent_artifact');
    assert.ok(reader);

    const result = await reader.execute(
      reader.validate?.({ artifactId: 'artifact:injected' }),
      { sessionId: 'session:injected', callId: 'call:injected' },
    );

    assert.deepEqual(readerArguments, { artifactId: 'artifact:injected' });
    assert.doesNotMatch(JSON.stringify(result), new RegExp('a'.repeat(43), 'u'));
    const consumed = evidenceHandoff.consume({
      sessionId: 'session:injected',
      toolCallId: 'call:injected',
    });
    assert.deepEqual(consumed?.evidence, evidence);
    assert.notEqual(consumed?.evidence, evidence);
    assert.equal(evidenceHandoff.consume({
      sessionId: 'session:injected',
      toolCallId: 'call:injected',
    }), null);
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
    ].sort((left, right) => (
      BGSM_AGENT_TOOL_CATALOG.findIndex(({ name }) => name === left)
      - BGSM_AGENT_TOOL_CATALOG.findIndex(({ name }) => name === right)
    )));
    assert.deepEqual(notes.getActiveToolNames(), [
      ...localReadNames,
      'read_repository_notes',
    ].sort((left, right) => (
      BGSM_AGENT_TOOL_CATALOG.findIndex(({ name }) => name === left)
      - BGSM_AGENT_TOOL_CATALOG.findIndex(({ name }) => name === right)
    )));
    assert.deepEqual(organization.getActiveToolNames(), [
      'request_full_library_organization',
      'start_full_library_analysis',
      ...localReadNames,
    ].sort((left, right) => (
      BGSM_AGENT_TOOL_CATALOG.findIndex(({ name }) => name === left)
      - BGSM_AGENT_TOOL_CATALOG.findIndex(({ name }) => name === right)
    )));
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
    assert.throws(
      () => createBgsmAgentToolRegistry({
        repositoryScope: ['owner/repo'],
        artifactReader: unavailableArtifactReader,
      }),
      /both a reader and evidence handoff/u,
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
