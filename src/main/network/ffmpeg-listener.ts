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
      '-fflags', '+genpts',
      '-use_wallclock_as_timestamps', '1',
      '-i', url,
      // Re-encode to baseline profile level 3.0 so the avcC box in
      // the init segment matches the MIME we declare to MSE
      // (avc1.42E01E). With -c:v copy, the listener can't reliably
      // extract SPS/PPS from the RTSP demuxer in time to write a
      // valid moov, so Chromium's MSE parser rejects the init
      // segment with CHUNK_DEMUXER_ERROR_APPEND_FAILED. Re-encoding
      // is wasteful in production but the cost is small (1280x800
      // @ 30fps with ultrafast preset is a few % CPU) and the
      // resulting fMP4 stream is guaranteed clean. Worth revisiting
      // -c:v copy once the standalone bug is understood.
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-profile:v', 'baseline',
      '-level', '3.0',
      '-pix_fmt', 'yuv420p',
      '-g', '30',
      '-an',
      '-avoid_negative_ts', 'make_zero',
      '-video_track_timescale', '90000',
      '-frag_duration', '500000',
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
