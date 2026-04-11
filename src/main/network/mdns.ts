// mDNS responder: publishes a single _discdeck._tcp.local service record
// advertising the event WebSocket and RTSP listener ports so the Decky
// plugin (Part 2) can discover this PC without manual IP config. The
// video relay port is NOT advertised — it is localhost-only.

import { Bonjour } from 'bonjour-service';
import os from 'os';
import logger from '../log.js';

export interface MdnsService {
  stop(): Promise<void>;
}

export interface MdnsOptions {
  eventPort: number;
  rtspPort: number;
  serviceName?: string;
}

export function publishMdnsService(options: MdnsOptions): MdnsService {
  const bonjour = new Bonjour();
  const name = options.serviceName ?? `Discdeck on ${os.hostname()}`;
  const service = bonjour.publish({
    name,
    type: 'discdeck',
    protocol: 'tcp',
    port: options.eventPort,
    txt: {
      event_port: String(options.eventPort),
      rtsp_port: String(options.rtspPort),
      protocol_version: '1',
    },
  });
  service.on('up', () => logger.info(`mdns: published ${name} (event=${options.eventPort}, rtsp=${options.rtspPort})`));
  service.on('error', (err: Error) => logger.warn('mdns: error', err));

  return {
    async stop() {
      await new Promise<void>((resolve) => {
        if (typeof service.stop === 'function') {
          service.stop(() => resolve());
        } else {
          resolve();
        }
      });
      bonjour.destroy();
      logger.info('mdns: stopped');
    },
  };
}
