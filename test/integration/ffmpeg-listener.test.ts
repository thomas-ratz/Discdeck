import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { createFfmpegListener, type FfmpegListener } from '../../src/main/network/ffmpeg-listener.js';

let listener: FfmpegListener | null = null;
let producer: ChildProcess | null = null;

afterEach(async () => {
  if (producer) {
    producer.kill('SIGKILL');
    producer = null;
  }
  if (listener) {
    await listener.stop();
    listener = null;
  }
});

function pushTestPattern(port: number): ChildProcess {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not provide a binary path');
  return spawn(
    ffmpegPath,
    [
      '-re',
      '-f', 'lavfi',
      '-i', 'testsrc2=size=320x240:rate=15:duration=2',
      '-c:v', 'libx264',
      '-tune', 'zerolatency',
      '-preset', 'ultrafast',
      '-g', '15',
      '-pix_fmt', 'yuv420p',
      '-x264opts', 'repeat-headers=1',
      '-rtsp_transport', 'tcp',
      '-f', 'rtsp',
      `rtsp://127.0.0.1:${port}/deck`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
}

describe('ffmpeg-listener', () => {
  it('receives fMP4 chunks from a real RTSP push', async () => {
    listener = await createFfmpegListener({ port: 18554 });
    let chunkCount = 0;
    let totalBytes = 0;
    listener.onChunk((buf) => {
      chunkCount += 1;
      totalBytes += buf.length;
    });
    listener.start();

    // Give the listener a moment to be ready before pushing.
    // Windows ffmpeg-listen takes ~1s to bind reliably.
    await new Promise((r) => setTimeout(r, 1000));
    producer = pushTestPattern(18554);

    // Wait up to 8 seconds for first chunks
    const start = Date.now();
    while (chunkCount === 0 && Date.now() - start < 8_000) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(chunkCount).toBeGreaterThan(0);
    expect(totalBytes).toBeGreaterThan(100);
  }, 20_000);
});
