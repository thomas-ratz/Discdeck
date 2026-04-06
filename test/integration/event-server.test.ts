import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startEventServer, type EventServer } from '../../src/main/network/event-server.js';
import { makeMessage } from '../../src/main/network/event-protocol.js';

let server: EventServer | null = null;

beforeEach(async () => {
  server = await startEventServer({ port: 0, heartbeatIntervalMs: 200, heartbeatTimeoutMs: 600 });
});

afterEach(async () => {
  if (server) await server.stop();
  server = null;
});

function url(): string {
  return `ws://127.0.0.1:${server!.port}/events`;
}

function open(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url());
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function recv(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(data.toString()));
    ws.once('error', reject);
  });
}

describe('event-server: handshake', () => {
  it('accepts hello and replies with welcome', async () => {
    const ws = await open();
    ws.send(JSON.stringify(makeMessage('hello', { client: 'test', client_version: '0.0.0', deck_name: 'TestDeck', capabilities: ['video', 'events'] })));
    const reply = JSON.parse(await recv(ws));
    expect(reply.type).toBe('welcome');
    expect(reply.v).toBe(1);
    ws.close();
  });
});

async function helloAndWelcome(ws: WebSocket): Promise<void> {
  ws.send(JSON.stringify(makeMessage('hello', { client: 'test', client_version: '0.0.0', deck_name: 'TestDeck', capabilities: ['video', 'events'] })));
  const reply = JSON.parse(await recv(ws));
  if (reply.type !== 'welcome') throw new Error('expected welcome, got ' + reply.type);
}

describe('event-server: single connection enforcement', () => {
  it('closes the previous connection when a second client connects', async () => {
    const a = await open();
    await helloAndWelcome(a);
    const closedReason = new Promise<number>((resolve) => a.once('close', (code) => resolve(code)));
    const b = await open();
    await helloAndWelcome(b);
    const code = await closedReason;
    expect(code).toBe(4000);
    b.close();
  });
});

describe('event-server: callback fan-out', () => {
  it('forwards non-heartbeat messages to onMessage', async () => {
    const received: string[] = [];
    server!.setCallbacks({
      onMessage: (msg) => received.push(msg.type),
    });
    const ws = await open();
    await helloAndWelcome(ws);
    ws.send(JSON.stringify(makeMessage('game_start', { game_name: 'Hollow Knight' })));
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toContain('game_start');
    expect(received).not.toContain('heartbeat');
    ws.close();
  });

  it('does not forward heartbeats but does reset the timeout', async () => {
    let dropped = false;
    server!.setCallbacks({
      onDisconnected: () => {
        dropped = true;
      },
    });
    const ws = await open();
    await helloAndWelcome(ws);
    // Send heartbeats faster than the configured timeout
    const interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(makeMessage('heartbeat')));
      }
    }, 100);
    await new Promise((r) => setTimeout(r, 1200)); // longer than heartbeatTimeoutMs=600
    clearInterval(interval);
    expect(dropped).toBe(false);
    ws.close();
  });
});

describe('event-server: heartbeat timeout', () => {
  it('drops the connection if no message arrives within the timeout window', async () => {
    let dropped = false;
    server!.setCallbacks({
      onDisconnected: () => {
        dropped = true;
      },
    });
    const ws = await open();
    await helloAndWelcome(ws);
    // Stop responding entirely; server will time us out (heartbeatTimeoutMs=600)
    await new Promise((r) => setTimeout(r, 1200));
    expect(dropped).toBe(true);
    ws.terminate();
  });
});

describe('event-server: bad input', () => {
  it('closes connection on garbage hello', async () => {
    const ws = await open();
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ws.send('not even json');
    await closed;
  });

  it('closes connection if first message is not hello', async () => {
    const ws = await open();
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ws.send(JSON.stringify(makeMessage('game_start', { game_name: 'X' })));
    await closed;
  });
});
