// Event WebSocket server: accepts a single active Deck connection,
// performs the hello/welcome handshake, relays non-heartbeat messages
// to the consumer via callbacks, and enforces heartbeat-based liveness.
// See docs/PROTOCOL.md (written in Task 18) for the wire format.

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { AddressInfo } from 'net';
import { parseMessage, makeMessage, type EventMessage } from './event-protocol.js';
import logger from '../log.js';

export interface EventServerOptions {
  port: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  serverVersion?: string;
}

export interface EventServerCallbacks {
  onConnected?: (info: { deckName: string }) => void;
  onDisconnected?: () => void;
  onMessage?: (msg: EventMessage) => void;
  onError?: (err: { code: string; reason: string }) => void;
}

export interface EventServer {
  port: number;
  setCallbacks(cb: EventServerCallbacks): void;
  send(msg: EventMessage): void;
  stop(): Promise<void>;
}

const REPLACED_CODE = 4000;

export function startEventServer(options: EventServerOptions): Promise<EventServer> {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 15_000;
  const serverVersion = options.serverVersion ?? '0.1.0';

  let callbacks: EventServerCallbacks = {};
  let activeSocket: WebSocket | null = null;
  let activeHeartbeatInterval: NodeJS.Timeout | null = null;
  let activeTimeoutTimer: NodeJS.Timeout | null = null;
  let activeDeckName: string | null = null;

  const wss = new WebSocketServer({ port: options.port, path: '/events' });

  function clearActiveTimers() {
    if (activeHeartbeatInterval) clearInterval(activeHeartbeatInterval);
    if (activeTimeoutTimer) clearTimeout(activeTimeoutTimer);
    activeHeartbeatInterval = null;
    activeTimeoutTimer = null;
  }

  function tearDownActive(reason: string) {
    clearActiveTimers();
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      try {
        activeSocket.close(1000, reason);
      } catch {
        /* ignore */
      }
    }
    activeSocket = null;
    if (activeDeckName !== null) {
      activeDeckName = null;
      callbacks.onDisconnected?.();
    }
  }

  function resetTimeout() {
    if (activeTimeoutTimer) clearTimeout(activeTimeoutTimer);
    activeTimeoutTimer = setTimeout(() => {
      logger.warn('event-server: heartbeat timeout, closing connection');
      tearDownActive('heartbeat timeout');
    }, heartbeatTimeoutMs);
  }

  wss.on('connection', (socket) => {
    if (activeSocket) {
      logger.info('event-server: replacing previous connection');
      try {
        activeSocket.close(REPLACED_CODE, 'replaced');
      } catch {
        /* ignore */
      }
      clearActiveTimers();
      activeSocket = null;
    }

    let handshakeComplete = false;

    const handshakeTimeout = setTimeout(() => {
      if (!handshakeComplete) {
        logger.warn('event-server: handshake timeout, closing');
        try {
          socket.close(1002, 'handshake timeout');
        } catch {
          /* ignore */
        }
      }
    }, 5_000);

    socket.on('message', (data: RawData) => {
      const raw = data.toString();
      const result = parseMessage(raw);
      if (!result.ok) {
        logger.warn('event-server: parse error', result);
        callbacks.onError?.({ code: result.code, reason: result.reason });
        try {
          socket.close(1002, result.code);
        } catch {
          /* ignore */
        }
        return;
      }

      if (!handshakeComplete) {
        if (result.message.type !== 'hello') {
          logger.warn('event-server: first message was not hello');
          try {
            socket.close(1002, 'expected hello');
          } catch {
            /* ignore */
          }
          return;
        }
        clearTimeout(handshakeTimeout);
        handshakeComplete = true;
        activeSocket = socket;
        const deckName =
          typeof result.message.data.deck_name === 'string' ? result.message.data.deck_name : 'Unknown Deck';
        activeDeckName = deckName;
        const welcome = makeMessage('welcome', {
          server: 'discdeck-pc',
          server_version: serverVersion,
          accepted_capabilities: ['video', 'events'],
        });
        try {
          socket.send(JSON.stringify(welcome));
        } catch (e) {
          logger.error('event-server: failed to send welcome', e);
        }

        // Start heartbeat & timeout cycle
        activeHeartbeatInterval = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            try {
              socket.send(JSON.stringify(makeMessage('heartbeat')));
            } catch (e) {
              logger.warn('event-server: heartbeat send failed', e);
            }
          }
        }, heartbeatIntervalMs);
        resetTimeout();

        callbacks.onConnected?.({ deckName });
        return;
      }

      // Past handshake: any received message resets the timeout
      resetTimeout();
      // Heartbeats are not forwarded to the consumer
      if (result.message.type !== 'heartbeat') {
        callbacks.onMessage?.(result.message);
      }
    });

    socket.on('close', () => {
      clearTimeout(handshakeTimeout);
      if (activeSocket === socket) {
        tearDownActive('peer closed');
      }
    });

    socket.on('error', (err) => {
      logger.warn('event-server: socket error', err);
    });
  });

  return new Promise((resolve, reject) => {
    wss.once('listening', () => {
      const addr = wss.address() as AddressInfo;
      logger.info(`event-server: listening on :${addr.port}/events`);
      resolve({
        get port() {
          return addr.port;
        },
        setCallbacks(cb) {
          callbacks = cb;
        },
        send(msg) {
          if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
            try {
              activeSocket.send(JSON.stringify(msg));
            } catch (e) {
              logger.warn('event-server: send failed', e);
            }
          }
        },
        async stop() {
          tearDownActive('server stop');
          await new Promise<void>((res) => wss.close(() => res()));
          logger.info('event-server: stopped');
        },
      });
    });
    wss.once('error', reject);
  });
}
