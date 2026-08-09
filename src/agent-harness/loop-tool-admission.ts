import { utf8ByteLength } from './results';
import type {
  AgentRequiredBeforeFinalDirective,
  AgentToolResultAdmission,
  ToolResult,
} from './tools';

const MAX_AGENT_OPAQUE_VALUE_BYTES = 512;
const MAX_AGENT_OPAQUE_VALUES = 128;

export function validateAgentToolResultAdmission(admission: AgentToolResultAdmission): void {
  if (!admission || typeof admission !== 'object' || Array.isArray(admission)) {
    throw new TypeError('Invalid tool-result admission.');
  }
  const result = admission.result as ToolResult | undefined;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('Invalid admitted tool result.');
  }
  if (result.ok === true) {
    if (!('data' in result)) throw new TypeError('Invalid admitted success result.');
  } else if (
    result.ok !== false
    || !result.error
    || typeof result.error.code !== 'string'
    || typeof result.error.message !== 'string'
  ) {
    throw new TypeError('Invalid admitted error result.');
  }
  if (admission.dispose !== undefined && typeof admission.dispose !== 'function') {
    throw new TypeError('Invalid admission disposer.');
  }
  if (admission.retainOnNoProgress !== undefined && typeof admission.retainOnNoProgress !== 'boolean') {
    throw new TypeError('Invalid no-progress admission marker.');
  }
}

export function normalizeOpaqueReferences(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_AGENT_OPAQUE_VALUES) {
    throw new TypeError('Invalid opaque references.');
  }
  const normalized = values.map((value) => normalizeOpaqueValue(value));
  normalized.sort();
  for (let index = 1; index < normalized.length; index++) {
    if (normalized[index] === normalized[index - 1]) {
      throw new TypeError('Duplicate opaque reference.');
    }
  }
  return normalized;
}

export function normalizeRequiredBeforeFinal(
  values: readonly AgentRequiredBeforeFinalDirective[],
): AgentRequiredBeforeFinalDirective[] {
  if (!Array.isArray(values) || values.length > MAX_AGENT_OPAQUE_VALUES) {
    throw new TypeError('Invalid required-before-final directives.');
  }
  const normalized = values.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Invalid required-before-final directive.');
    }
    if (value.requiredBeforeFinal !== true) {
      throw new TypeError('Invalid required-before-final directive marker.');
    }
    return {
      reference: normalizeOpaqueValue(value.reference),
      progressToken: normalizeOpaqueValue(value.progressToken),
      requiredBeforeFinal: true as const,
    };
  });
  normalized.sort((left, right) => (
    left.reference < right.reference ? -1 : left.reference > right.reference ? 1 : 0
  ));
  for (let index = 1; index < normalized.length; index++) {
    if (normalized[index]?.reference === normalized[index - 1]?.reference) {
      throw new TypeError('Duplicate required-before-final directive.');
    }
  }
  return normalized;
}

export function hasRequiredBeforeFinalProgress(
  previous: readonly AgentRequiredBeforeFinalDirective[],
  next: readonly AgentRequiredBeforeFinalDirective[],
): boolean {
  const nextByReference = new Map(next.map((directive) => [directive.reference, directive]));
  return previous.some((directive) => (
    nextByReference.get(directive.reference)?.progressToken !== directive.progressToken
  ));
}

export async function disposeBestEffort(
  disposals: readonly (() => Promise<void>)[],
): Promise<void> {
  for (const dispose of disposals) {
    try {
      await dispose();
    } catch {
      // The host owns its cleanup backstop; admission must not surface disposal failures.
    }
  }
}

function normalizeOpaqueValue(value: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || utf8ByteLength(value) > MAX_AGENT_OPAQUE_VALUE_BYTES
  ) {
    throw new TypeError('Invalid opaque admission value.');
  }
  return value;
}
