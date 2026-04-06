// Event protocol v1: typed envelope, validator, and message factory for the
// WebSocket channel between Discdeck PC and the Decky plugin. Pure JSON —
// no I/O. Per-type data shape is not enforced here (event-server does that).

import { v4 as uuidv4 } from 'uuid';

export const PROTOCOL_VERSION = 1 as const;

export type EventMessageType =
  | 'hello'
  | 'welcome'
  | 'game_start'
  | 'game_change'
  | 'game_stop'
  | 'stream_starting'
  | 'stream_stopped'
  | 'heartbeat'
  | 'error';

export const KNOWN_TYPES: ReadonlySet<EventMessageType> = new Set([
  'hello',
  'welcome',
  'game_start',
  'game_change',
  'game_stop',
  'stream_starting',
  'stream_stopped',
  'heartbeat',
  'error',
]);

export interface EventMessage<T extends EventMessageType = EventMessageType> {
  v: number;
  type: T;
  id: string;
  ts: string;
  data: Record<string, unknown>;
}

export type ParseResult =
  | { ok: true; message: EventMessage }
  | {
      ok: false;
      code: 'bad_json' | 'bad_envelope' | 'unknown_type' | 'version_mismatch';
      reason: string;
    };

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function parseMessage(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, code: 'bad_json', reason: (e as Error).message };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, code: 'bad_envelope', reason: 'message is not a JSON object' };
  }
  const { v, type, id, ts, data } = parsed as Record<string, unknown>;
  if (typeof v !== 'number') {
    return { ok: false, code: 'bad_envelope', reason: 'v must be a number' };
  }
  if (v !== PROTOCOL_VERSION) {
    return { ok: false, code: 'version_mismatch', reason: `expected v=${PROTOCOL_VERSION}, got v=${v}` };
  }
  if (typeof type !== 'string') {
    return { ok: false, code: 'bad_envelope', reason: 'type must be a string' };
  }
  if (!KNOWN_TYPES.has(type as EventMessageType)) {
    return { ok: false, code: 'unknown_type', reason: `unknown message type: ${type}` };
  }
  if (typeof id !== 'string') {
    return { ok: false, code: 'bad_envelope', reason: 'id must be a string' };
  }
  if (typeof ts !== 'string') {
    return { ok: false, code: 'bad_envelope', reason: 'ts must be a string' };
  }
  if (!isPlainObject(data)) {
    return { ok: false, code: 'bad_envelope', reason: 'data must be an object' };
  }
  return {
    ok: true,
    message: { v, type: type as EventMessageType, id, ts, data },
  };
}

export function makeMessage<T extends EventMessageType>(
  type: T,
  data: Record<string, unknown> = {},
): EventMessage<T> {
  return {
    v: PROTOCOL_VERSION,
    type,
    id: uuidv4(),
    ts: new Date().toISOString(),
    data,
  };
}
