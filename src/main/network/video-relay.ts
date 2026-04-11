// Localhost video relay: a tiny WebSocketServer bound to 127.0.0.1 that
// broadcasts fMP4 chunks from the ffmpeg listener to the Electron renderer.
// Not discoverable on the LAN (bound to loopback). Renderer is the only
// expected client.
//
// Buffering: chunks are accumulated into a per-session buffer (capped at
// MAX_BUFFER_BYTES) and replayed to any new client on connection. This
// fixes a race where the renderer's WebSocket connects AFTER ffmpeg has
// already written the init segment (ftyp + moov), which would otherwise
// be lost — leaving Chromium MSE with only moof+mdat fragments and no
// way to validate them. The session buffer is cleared by resetSession()
// whenever the main process respawns ffmpeg.

import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'net';
import logger from '../log.js';

const MAX_BUFFER_BYTES = 4 * 1024 * 1024; // 4 MB cap

export interface VideoRelay {
  port: number;
  push(chunk: Buffer): void;
  resetSession(): void;
  stop(): Promise<void>;
}

export function startVideoRelay(): Promise<VideoRelay> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });

  // Per-session buffer of chunks since the last resetSession() call.
  // The first portion (~1KB) contains the fMP4 init segment that any
  // new client needs in order to start parsing.
  let sessionBuffer: Buffer[] = [];
  let sessionBufferBytes = 0;
  let bufferCapHit = false;

  return new Promise((resolve, reject) => {
    wss.once('listening', () => {
      const addr = wss.address() as AddressInfo;
      logger.info(`video-relay: listening on 127.0.0.1:${addr.port}`);

      wss.on('connection', (socket) => {
        logger.info(
          `video-relay: client connected, replaying ${sessionBuffer.length} buffered chunks (${sessionBufferBytes} bytes)`,
        );
        for (const chunk of sessionBuffer) {
          if (socket.readyState === WebSocket.OPEN) {
            try {
              socket.send(chunk, { binary: true });
            } catch (e) {
              logger.warn('video-relay: replay send failed', e);
            }
          }
        }
      });

      resolve({
        get port() {
          return addr.port;
        },
        push(chunk) {
          if (sessionBufferBytes < MAX_BUFFER_BYTES) {
            sessionBuffer.push(chunk);
            sessionBufferBytes += chunk.length;
            if (sessionBufferBytes >= MAX_BUFFER_BYTES && !bufferCapHit) {
              bufferCapHit = true;
              logger.info(
                `video-relay: session buffer cap hit (${sessionBufferBytes} bytes); late-joining clients will get partial replay`,
              );
            }
          }
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
        resetSession() {
          if (sessionBufferBytes > 0) {
            logger.info(`video-relay: resetSession (clearing ${sessionBufferBytes} bytes)`);
          }
          sessionBuffer = [];
          sessionBufferBytes = 0;
          bufferCapHit = false;
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
