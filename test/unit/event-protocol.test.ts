import { describe, it, expect } from 'vitest';
import { parseMessage, makeMessage, PROTOCOL_VERSION } from '../../src/main/network/event-protocol.js';

describe('parseMessage', () => {
  it('exports the protocol version constant', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('parses a valid hello envelope', () => {
    const raw = JSON.stringify({
      v: 1,
      type: 'hello',
      id: 'abc',
      ts: '2026-04-06T00:00:00.000Z',
      data: { client: 'decky-discdeck', client_version: '0.1.0', deck_name: 'X', capabilities: [] },
    });
    const result = parseMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.type).toBe('hello');
      expect(result.message.v).toBe(1);
    }
  });
});

describe('parseMessage — error paths', () => {
  it('rejects non-JSON input', () => {
    const r = parseMessage('not json {');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_json');
  });

  it('rejects a JSON array', () => {
    const r = parseMessage('[]');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_envelope');
  });

  it('rejects missing v', () => {
    const r = parseMessage(JSON.stringify({ type: 'hello', id: 'a', ts: 'b', data: {} }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_envelope');
  });

  it('rejects version mismatch', () => {
    const r = parseMessage(JSON.stringify({ v: 99, type: 'hello', id: 'a', ts: 'b', data: {} }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('version_mismatch');
  });

  it('rejects unknown type', () => {
    const r = parseMessage(JSON.stringify({ v: 1, type: 'mystery', id: 'a', ts: 'b', data: {} }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('unknown_type');
  });

  it('rejects non-object data', () => {
    const r = parseMessage(JSON.stringify({ v: 1, type: 'hello', id: 'a', ts: 'b', data: 'oops' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_envelope');
  });

  it('accepts every known type with empty data', () => {
    const types = [
      'hello',
      'welcome',
      'game_start',
      'game_change',
      'game_stop',
      'stream_starting',
      'stream_stopped',
      'heartbeat',
      'error',
    ] as const;
    for (const type of types) {
      const r = parseMessage(JSON.stringify({ v: 1, type, id: 'x', ts: 'y', data: {} }));
      expect(r.ok).toBe(true);
    }
  });
});

describe('makeMessage', () => {
  it('produces a valid envelope that round-trips through parseMessage', () => {
    const msg = makeMessage('heartbeat');
    const r = parseMessage(JSON.stringify(msg));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message.type).toBe('heartbeat');
      expect(r.message.v).toBe(1);
      expect(typeof r.message.id).toBe('string');
      expect(r.message.id.length).toBeGreaterThan(0);
    }
  });

  it('preserves custom data through round-trip', () => {
    const msg = makeMessage('game_start', { game_name: 'Hollow Knight', app_id: '367520' });
    const r = parseMessage(JSON.stringify(msg));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message.data.game_name).toBe('Hollow Knight');
  });
});
