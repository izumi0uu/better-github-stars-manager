declare const opaqueIdBrand: unique symbol;

type OpaqueId<Name extends string> = string & {
  readonly [opaqueIdBrand]: Name;
};

export type ControllerId = OpaqueId<'ControllerId'>;
export type RunId = OpaqueId<'RunId'>;
export type ProposalId = OpaqueId<'ProposalId'>;
export type OrganizeJobId = OpaqueId<'OrganizeJobId'>;

export const CONTROLLER_ID_PREFIX = 'controller:v1:';
export const RUN_ID_PREFIX = 'run:v1:';
export const PROPOSAL_ID_PREFIX = 'proposal:v1:';
export const ORGANIZE_JOB_ID_PREFIX = 'organize-job:v1:';

export function parseControllerId(value: string): ControllerId {
  return parseOpaqueId(value, CONTROLLER_ID_PREFIX, 'controllerId');
}

export function parseRunId(value: string): RunId {
  return parseOpaqueId(value, RUN_ID_PREFIX, 'runId');
}

export function parseProposalId(value: string): ProposalId {
  return parseOpaqueId(value, PROPOSAL_ID_PREFIX, 'proposalId');
}

export function parseOrganizeJobId(value: string): OrganizeJobId {
  return parseOpaqueId(value, ORGANIZE_JOB_ID_PREFIX, 'organizeJobId');
}

export function createOrganizeJobId(
  randomId: () => string = () => globalThis.crypto.randomUUID(),
): OrganizeJobId {
  return parseOrganizeJobId(`${ORGANIZE_JOB_ID_PREFIX}${randomId()}`);
}

export function isControllerId(value: unknown): value is ControllerId {
  return isOpaqueId(value, CONTROLLER_ID_PREFIX);
}

export function isRunId(value: unknown): value is RunId {
  return isOpaqueId(value, RUN_ID_PREFIX);
}

export function isProposalId(value: unknown): value is ProposalId {
  return isOpaqueId(value, PROPOSAL_ID_PREFIX);
}

export function isOrganizeJobId(value: unknown): value is OrganizeJobId {
  return isOpaqueId(value, ORGANIZE_JOB_ID_PREFIX);
}

function parseOpaqueId<Name extends string>(
  value: string,
  prefix: string,
  field: string,
): OpaqueId<Name> {
  if (!isOpaqueId(value, prefix)) {
    throw new TypeError(`${field} must be a nonempty ${prefix} identity.`);
  }
  return value as OpaqueId<Name>;
}

function isOpaqueId(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length;
}
