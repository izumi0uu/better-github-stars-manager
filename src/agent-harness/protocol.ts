import {
  MAX_GENERIC_TOOL_ERROR_RESULT_BYTES,
  MAX_GENERIC_TOOL_SUCCESS_RESULT_BYTES,
} from './const';
import type { ModelMessage } from './messages';
import {
  MAX_PROVIDER_ERROR_BYTES,
  type ModelToolCall,
} from './provider';
import { truncateUtf8, utf8ByteLength } from './results';

export type ProtocolValidationCode =
  | 'protocol_error'
  | 'provider_serialization_error';

export class ProtocolValidationError extends Error {
  readonly code: ProtocolValidationCode;

  constructor(code: ProtocolValidationCode, message: string) {
    super(truncateUtf8(message, MAX_PROVIDER_ERROR_BYTES));
    this.name = 'ProtocolValidationError';
    this.code = code;
  }
}

export function validateProviderProtocolHistory(messages: readonly ModelMessage[]): void {
  assertSerializableHistory(messages);
  const usedCallIds = new Set<string>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'tool') {
      throw protocolError('Provider history contains an orphan tool result.');
    }
    const calls = message.role === 'assistant' ? message.toolCalls ?? [] : [];
    if (calls.length === 0) continue;

    validateToolCallEnvelope(calls, usedCallIds);
    for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
      const call = calls[callIndex];
      const result = messages[index + callIndex + 1];
      if (!result || result.role !== 'tool') {
        throw protocolError('Assistant tool calls must be followed immediately by ordered results.');
      }
      if (result.toolCallId !== call.id || result.toolName !== call.name) {
        throw protocolError('Tool result linkage does not match the assistant call envelope.');
      }
      validateSerializedResult(result.content);
    }
    index += calls.length;
  }
}

export function validateToolCallEnvelope(
  calls: readonly ModelToolCall[],
  priorHistory: readonly ModelMessage[] | Set<string> = [],
): void {
  const usedCallIds = priorHistory instanceof Set
    ? priorHistory
    : collectToolCallIds(priorHistory);

  for (const call of calls) {
    if (
      typeof call.id !== 'string' ||
      call.id.trim().length === 0 ||
      call.id !== call.id.trim()
    ) {
      throw protocolError('Tool call IDs must be nonempty.');
    }
    if (
      typeof call.name !== 'string' ||
      call.name.trim().length === 0 ||
      call.name !== call.name.trim()
    ) {
      throw protocolError('Tool call names must be nonempty.');
    }
    if (usedCallIds.has(call.id)) {
      throw protocolError('Tool call IDs must be globally unique in provider history.');
    }
    usedCallIds.add(call.id);
  }
}

export function validateSerializedResult(serialized: string): void {
  if (typeof serialized !== 'string' || serialized.length === 0) {
    throw protocolError('Tool results must contain bounded JSON text.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw protocolError('Tool results must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw protocolError('Tool results must be JSON object envelopes.');
  }
  const record = parsed as Record<string, unknown>;
  const ok = record.ok;
  if (ok !== true && ok !== false) {
    throw protocolError('Tool results must contain a boolean ok field.');
  }
  if (ok) {
    if (
      !Object.prototype.hasOwnProperty.call(record, 'data') ||
      Object.keys(record).some((key) => key !== 'ok' && key !== 'data')
    ) throw protocolError('Successful tool results must match the ToolResult envelope.');
  } else {
    const error = record.error;
    if (
      !error ||
      typeof error !== 'object' ||
      Array.isArray(error) ||
      Object.keys(record).some((key) => key !== 'ok' && key !== 'error')
    ) throw protocolError('Failed tool results must match the ToolResult envelope.');
    const errorRecord = error as Record<string, unknown>;
    if (
      typeof errorRecord.code !== 'string' ||
      typeof errorRecord.message !== 'string' ||
      Object.keys(errorRecord).some((key) => key !== 'code' && key !== 'message') ||
      !Object.prototype.hasOwnProperty.call(errorRecord, 'code') ||
      !Object.prototype.hasOwnProperty.call(errorRecord, 'message')
    ) throw protocolError('Failed tool results must contain code and message strings.');
  }
  const limit = ok
    ? MAX_GENERIC_TOOL_SUCCESS_RESULT_BYTES
    : MAX_GENERIC_TOOL_ERROR_RESULT_BYTES;
  if (utf8ByteLength(serialized) > limit) {
    throw protocolError('Tool result exceeds its protocol byte limit.');
  }
}

function collectToolCallIds(messages: readonly ModelMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      if (typeof call.id === 'string') ids.add(call.id);
    }
  }
  return ids;
}

function assertSerializableHistory(messages: readonly ModelMessage[]): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(messages);
  } catch {
    throw new ProtocolValidationError(
      'provider_serialization_error',
      'Provider history could not be serialized safely.',
    );
  }
  if (typeof serialized !== 'string') {
    throw new ProtocolValidationError(
      'provider_serialization_error',
      'Provider history could not be serialized safely.',
    );
  }
}

function protocolError(message: string): ProtocolValidationError {
  return new ProtocolValidationError('protocol_error', message);
}
