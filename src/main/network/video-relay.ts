// Localhost video relay: a tiny WebSocketServer bound to 127.0.0.1 that
// broadcasts fMP4 chunks from the ffmpeg listener to the Electron renderer.
// Not discoverable on the LAN (bound to loopback). Renderer is the only
// expected client. No business logic — pure fan-out.

import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'net';
import logger from '../log.js';

export interface VideoRelay {
  port: number;
  push(chunk: Buffer): void;
  stop(): Promise<void>;
}

export function startVideoRelay(): Promise<VideoRelay> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });

  return new Promise((resolve, reject) => {
    wss.once('listening', () => {
      const addr = wss.address() as AddressInfo;
      logger.info(`video-relay: listening on 127.0.0.1:${addr.port}`);
      resolve({
        get port() {
          return addr.port;
        },
        push(chunk) {
          for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
              try {
                client.send(chunk, { binary: true });
              } catch (e) {
                logger.warn('video-relay: client send failed', e);
              }
            }
          }
        },
        async stop() {
          for (const client of wss.clients) {
            try {
              client.close(1001, 'shutdown');
            } catch {
              /* ignore */
            }
          }
          await new Promise<void>((res) => wss.close(() => res()));
          logger.info('video-relay: stopped');
        },
      });
    });
    wss.once('error', reject);
  });
}
