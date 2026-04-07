// FFmpeg listener: spawns and supervises a single bundled ffmpeg process
// running in RTSP listener mode. Stdout chunks are fragmented MP4 (no
// re-encode) intended for the video relay. Stop() escalates SIGTERM to
// SIGKILL after 2s. Crash-loop counting is the consumer's responsibility.

import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import ffmpegPath from 'ffmpeg-static';
import logger from '../log.js';

export interface FfmpegListenerOptions {
  port: number;
  bindHost?: string;
  path?: string;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  normal: boolean;
}

export interface FfmpegListener {
  start(): void;
  stop(): Promise<void>;
  onChunk(cb: (chunk: Buffer) => void): void;
  onExit(cb: (info: ExitInfo) => void): void;
}

export function createFfmpegListener(options: FfmpegListenerOptions): Promise<FfmpegListener> {
  const port = options.port;
  const host = options.bindHost ?? '0.0.0.0';
  const path = options.path ?? '/deck';
  const url = `rtsp://${host}:${port}${path}`;

  let proc: ChildProcessByStdio<null, Readable, Readable> | null = null;
  let chunkCb: ((chunk: Buffer) => void) | null = null;
  let exitCb: ((info: ExitInfo) => void) | null = null;
  let stopping = false;

  function spawnProc() {
    if (!ffmpegPath) {
      throw new Error('ffmpeg-static did not provide a binary path');
    }
    const args = [
      '-rtsp_flags', 'listen',
      '-i', url,
      '-c:v', 'copy',
      '-an',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1',
    ];
    logger.info(`ffmpeg-listener: spawning ${ffmpegPath} ${args.join(' ')}`);
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    p.stdout.on('data', (chunk: Buffer) => {
      if (chunkCb) chunkCb(chunk);
    });
    p.stderr.on('data', (chunk: Buffer) => {
      logger.debug(`ffmpeg-listener[stderr]: ${chunk.toString().trimEnd()}`);
    });
    p.on('exit', (code, signal) => {
      const normal = stopping || code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL';
      logger.info(`ffmpeg-listener: exit code=${code} signal=${signal} normal=${normal}`);
      proc = null;
      if (exitCb) exitCb({ code, signal, normal });
    });

    return p;
  }

  return Promise.resolve({
    start() {
      if (proc) return;
      stopping = false;
      proc = spawnProc();
    },
    async stop() {
      if (!proc) return;
      stopping = true;
      const p = proc;
      p.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          if (!p.killed) p.kill('SIGKILL');
          resolve();
        }, 2_000);
        p.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
      proc = null;
    },
    onChunk(cb) {
      chunkCb = cb;
    },
    onExit(cb) {
      exitCb = cb;
    },
  });
}
