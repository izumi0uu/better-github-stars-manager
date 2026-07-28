import type { ModelMessage } from './messages';

export type AgentContentCaptureRequestKind =
  | 'turn'
  | 'historical_summary'
  | 'active_turn_summary';

export type AgentContentCaptureRequestIdentity = Readonly<{
  requestId: string;
  requestKind: AgentContentCaptureRequestKind;
  providerStep: number | null;
  requestAttempt: number;
}>;

export type AgentContentCaptureSink = Readonly<{
  providerPrompt(
    identity: AgentContentCaptureRequestIdentity,
    messages: readonly ModelMessage[],
  ): void;
  providerResponse(
    identity: AgentContentCaptureRequestIdentity,
    response: Readonly<{ content?: string; refusal?: string }>,
  ): void;
  toolArguments(input: Readonly<{
    providerStep: number;
    toolName: string;
    toolCallId: string;
    content: string;
  }>): void;
  toolResult(input: Readonly<{
    providerStep: number;
    toolName: string;
    toolCallId: string;
    content: string;
  }>): void;
  finish(reason: string): void;
}>;

/** Serializes only Provider message content, never request transport data. */
export function serializeAgentCaptureMessages(messages: readonly ModelMessage[]): string {
  return safeCaptureJson(messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
    ...(message.toolCalls ? {
      toolCalls: message.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    } : {}),
  })));
}

export function serializeAgentCaptureValue(value: unknown): string {
  return typeof value === 'string' ? value : safeCaptureJson(value);
}

export function observeAgentContentCapture(
  sink: AgentContentCaptureSink | undefined,
  work: (sink: AgentContentCaptureSink) => void,
): void {
  if (!sink) return;
  try {
    work(sink);
  } catch {
    // Development observation cannot change Provider, tool, or terminal behavior.
  }
}

function safeCaptureJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, nested) => (
      typeof nested === 'bigint' ? nested.toString() : nested
    )) ?? 'null';
  } catch {
    return '[Unserializable content]';
  }
}
