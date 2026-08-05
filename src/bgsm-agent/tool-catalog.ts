import type { ToolRisk } from '@/agent-harness';

export const BGSM_AGENT_TOOL_REGISTRY_VERSION = 1;

export const BGSM_AGENT_TOOL_NAMES = Object.freeze({
  requestFullLibraryOrganization: 'request_full_library_organization',
  startFullLibraryAnalysis: 'start_full_library_analysis',
  listTags: 'list_tags',
  listStars: 'list_stars',
  getStar: 'get_star',
  searchStars: 'search_stars',
  inspectTag: 'inspect_tag',
  assignRepoTags: 'assign_repo_tags',
  removeRepoTags: 'remove_repo_tags',
  deleteTagsEverywhere: 'delete_tags_everywhere',
  listRepositoryFiles: 'list_repository_files',
  searchRepositoryCode: 'search_repository_code',
  readRepositoryFile: 'read_repository_file',
  readRepositoryNotes: 'read_repository_notes',
} as const);

export type BgsmAgentToolName = (
  typeof BGSM_AGENT_TOOL_NAMES
)[keyof typeof BGSM_AGENT_TOOL_NAMES];

export type BgsmAgentToolCapability =
  | 'local_stars'
  | 'tag_writes'
  | 'library_organization'
  | 'repository_code'
  | 'repository_notes';

export type BgsmAgentToolPresentation =
  | 'repository_data'
  | 'tag_changes'
  | 'organization'
  | 'repository_code';

export type BgsmAgentToolEvidenceSource =
  | 'none'
  | 'repository_from_star'
  | 'repositories_from_stars'
  | 'tags_from_list'
  | 'repository_tags_from_inspection';

export type BgsmAgentToolWritePolicy =
  | 'none'
  | 'assign_tags'
  | 'remove_tags'
  | 'delete_tags';

export type BgsmAgentToolDefinition = Readonly<{
  name: BgsmAgentToolName;
  risk: ToolRisk;
  capability: BgsmAgentToolCapability;
  visibility: 'base' | 'task';
  presentation: BgsmAgentToolPresentation;
  evidenceSource: BgsmAgentToolEvidenceSource;
  writePolicy: BgsmAgentToolWritePolicy;
  exclusiveEnvelope: boolean;
}>;

const definitions = [
  define({
    name: BGSM_AGENT_TOOL_NAMES.requestFullLibraryOrganization,
    risk: 'suggest',
    capability: 'library_organization',
    visibility: 'base',
    presentation: 'organization',
    evidenceSource: 'none',
    writePolicy: 'none',
    exclusiveEnvelope: true,
  }),
  define({
    name: BGSM_AGENT_TOOL_NAMES.startFullLibraryAnalysis,
    risk: 'suggest',
    capability: 'library_organization',
    visibility: 'base',
    presentation: 'organization',
    evidenceSource: 'none',
    writePolicy: 'none',
    exclusiveEnvelope: true,
  }),
  define({
    name: BGSM_AGENT_TOOL_NAMES.listTags,
    risk: 'read',
    capability: 'local_stars',
    visibility: 'base',
    presentation: 'repository_data',
    evidenceSource: 'tags_from_list',
    writePolicy: 'none',
    exclusiveEnvelope: false,
  }),
  define({
    name: BGSM_AGENT_TOOL_NAMES.listStars,
    risk: 'read',
    capability: 'local_stars',
    visibility: 'base',
    presentation: 'repository_data',
    evidenceSource: 'repositories_from_stars',
    writePolicy: 'none',
    exclusiveEnvelope: false,
  }),
  define({
    name: BGSM_AGENT_TOOL_NAMES.getStar,
    risk: 'read',
    capability: 'local_stars',
    visibility: 'base',
    presentation: 'repository_data',
    evidenceSource: 'repository_from_star',
    writePolicy: 'none',
    exclusiveEnvelope: false,
  }),
  define({
    name: BGSM_AGENT_TOOL_NAMES.searchStars,
    risk: 'read',
    capability: 'local_stars',
    visibility: 'base',
    presentation: 'repository_data',
    evidenceSource: 'repositories_from_stars',
    writePolicy: 'none',
    exclusiveEnvelope: false,
  }),
  define({
    name: BGSM_AGENT_TOOL_NAMES.inspectTag,
    risk: 'read',
    capability: 'local_stars',
    visibility: 'base',
    presentation: 'repository_data',
    evidenceSource: 'repository_tags_from_inspection',
    writePolicy: 'none',
    exclusiveEnvelope: false,
  }),
  define({
    name: BGSM_AGENT_TOOL_NAMES.assignRepoTags,
    risk: 'write',
    capability: 'tag_writes',
    visibility: 'base',
    presentation: 'tag_changes',
    evidenceSource: 'none',
    writePolicy: 'assign_tags',
    exclusiveEnvelope: false,
  }),
  define({
    name: BGSM_AGENT_TOOL_NAMES.removeRepoTags,
    risk: 'write',
    capability: 'tag_writes',
    visibility: 'base',
    presentation: 'tag_changes',
    evidenceSource: 'none',
    writePolicy: 'remove_tags',
    exclusiveEnvelope: false,
  }),
  define({
    name: BGSM_AGENT_TOOL_NAMES.deleteTagsEverywhere,
    risk: 'write',
    capability: 'tag_writes',
    visibility: 'base',
    presentation: 'tag_changes',
    evidenceSource: 'none',
    writePolicy: 'delete_tags',
    exclusiveEnvelope: false,
  }),
  define({
    name: BGSM_AGENT_TOOL_NAMES.listRepositoryFiles,
    risk: 'read',
    capability: 'repository_code',
    visibility: 'task',
    presentation: 'repository_code',
    evidenceSource: 'none',
    writePolicy: 'none',
    exclusiveEnvelope: false,
  }),
  define({
    name: BGSM_AGENT_TOOL_NAMES.searchRepositoryCode,
    risk: 'read',
    capability: 'repository_code',
    visibility: 'task',
    presentation: 'repository_code',
    evidenceSource: 'none',
    writePolicy: 'none',
    exclusiveEnvelope: false,
  }),
  define({
    name: BGSM_AGENT_TOOL_NAMES.readRepositoryFile,
    risk: 'read',
    capability: 'repository_code',
    visibility: 'task',
    presentation: 'repository_code',
    evidenceSource: 'none',
    writePolicy: 'none',
    exclusiveEnvelope: false,
  }),
  define({
    name: BGSM_AGENT_TOOL_NAMES.readRepositoryNotes,
    risk: 'read',
    capability: 'repository_notes',
    visibility: 'task',
    presentation: 'repository_data',
    evidenceSource: 'none',
    writePolicy: 'none',
    exclusiveEnvelope: false,
  }),
] as const satisfies readonly BgsmAgentToolDefinition[];

export const BGSM_AGENT_TOOL_CATALOG: readonly BgsmAgentToolDefinition[] = Object.freeze(
  [...definitions],
);

const definitionByName = createDefinitionIndex(BGSM_AGENT_TOOL_CATALOG);

export function getBgsmAgentToolDefinition(
  name: string | undefined,
): BgsmAgentToolDefinition | undefined {
  return isBgsmAgentToolName(name) ? definitionByName.get(name) : undefined;
}

export function isBgsmAgentToolName(name: string | undefined): name is BgsmAgentToolName {
  return !!name && definitionByName.has(name as BgsmAgentToolName);
}

export function isBgsmAgentToolCapability(
  name: string | undefined,
  capability: BgsmAgentToolCapability,
): boolean {
  return getBgsmAgentToolDefinition(name)?.capability === capability;
}

export function isBgsmAgentTagWriteTool(name: string | undefined): boolean {
  const definition = getBgsmAgentToolDefinition(name);
  return definition?.capability === 'tag_writes' && definition.risk === 'write';
}

function define(definition: BgsmAgentToolDefinition): BgsmAgentToolDefinition {
  if ((definition.writePolicy !== 'none') !== (definition.risk === 'write')) {
    throw new TypeError(`Cubby tool ${definition.name} has an inconsistent write policy.`);
  }
  return Object.freeze(definition);
}

function createDefinitionIndex(
  catalog: readonly BgsmAgentToolDefinition[],
): ReadonlyMap<BgsmAgentToolName, BgsmAgentToolDefinition> {
  const index = new Map<BgsmAgentToolName, BgsmAgentToolDefinition>();
  for (const definition of catalog) {
    if (index.has(definition.name)) {
      throw new TypeError(`Duplicate Cubby tool definition: ${definition.name}`);
    }
    index.set(definition.name, definition);
  }
  return index;
}
