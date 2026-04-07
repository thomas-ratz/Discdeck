#!/usr/bin/env tsx
import WebSocket from 'ws';
import { spawn, type ChildProcess } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { makeMessage } from '../../src/main/network/event-protocol.js';

const HOST = process.env.DISCDECK_HOST ?? '127.0.0.1';
const EVENT_URL = `ws://${HOST}:8765/events`;
const RTSP_URL = `rtsp://${HOST}:8554/deck`;

function log(...args: unknown[]) {
  console.log('[dummy]', ...args);
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function connect(): Promise<WebSocket> {
  log('connecting to', EVENT_URL);
  const ws = new WebSocket(EVENT_URL);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

function send(ws: WebSocket, type: Parameters<typeof makeMessage>[0], data: Record<string, unknown> = {}) {
  const msg = makeMessage(type, data);
  log('→', type, JSON.stringify(data));
  ws.send(JSON.stringify(msg));
}

async function helloAndWelcome(ws: WebSocket): Promise<void> {
  send(ws, 'hello', {
    client: 'dummy-producer',
    client_version: '0.0.0-test',
    deck_name: 'Test Deck',
    capabilities: ['video', 'events'],
  });
  await new Promise<void>((resolve, reject) => {
    const onMsg = (data: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'welcome') {
          log('← welcome from', parsed.data?.server, parsed.data?.server_version);
          ws.removeListener('message', onMsg);
          resolve();
        }
      } catch (e) {
        reject(e);
      }
    };
    ws.on('message', onMsg);
    setTimeout(() => reject(new Error('welcome timeout')), 5000);
  });
}

function startHeartbeats(ws: WebSocket): NodeJS.Timeout {
  return setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) send(ws, 'heartbeat');
  }, 5000);
}

function spawnTestPatternPush(): ChildProcess {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not provide a binary path');
  log('spawning ffmpeg test pattern push to', RTSP_URL);
  const child = spawn(
    ffmpegPath,
    [
      '-re',
      '-f', 'lavfi',
      '-i', 'testsrc2=size=1280x800:rate=30',
      '-c:v', 'libx264',
      '-tune', 'zerolatency',
      '-preset', 'ultrafast',
      '-g', '30',
      '-pix_fmt', 'yuv420p',
      '-x264opts', 'repeat-headers=1',
      '-rtsp_transport', 'tcp',
      '-f', 'rtsp',
      RTSP_URL,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  child.on('exit', (code, signal) => log('ffmpeg push exited code=', code, 'signal=', signal));
  return child;
}

async function full() {
  const ws = await connect();
  await helloAndWelcome(ws);
  const hb = startHeartbeats(ws);
  await sleep(500);
  send(ws, 'game_start', { game_name: 'Hollow Knight', app_id: '367520', launched_at: new Date().toISOString() });
  await sleep(2000);
  send(ws, 'stream_starting', {
    rtsp_url: RTSP_URL,
    video_codec: 'h264',
    width: 1280,
    height: 800,
    fps: 30,
  });
  const ff = spawnTestPatternPush();
  log('streaming for 15 seconds…');
  await sleep(8000);
  send(ws, 'game_change', { game_name: 'Hades', app_id: '1145360', launched_at: new Date().toISOString() });
  await sleep(7000);
  send(ws, 'stream_stopped', { reason: 'user_toggled_off' });
  ff.kill('SIGINT');
  await sleep(1000);
  send(ws, 'game_stop', { game_name: 'Hades', closed_at: new Date().toISOString() });
  clearInterval(hb);
  ws.close();
  log('done');
}

async function eventsOnly() {
  const ws = await connect();
  await helloAndWelcome(ws);
  const hb = startHeartbeats(ws);
  await sleep(500);
  send(ws, 'game_start', { game_name: 'Hollow Knight', app_id: '367520', launched_at: new Date().toISOString() });
  await sleep(3000);
  send(ws, 'game_change', { game_name: 'Celeste', app_id: '504230', launched_at: new Date().toISOString() });
  await sleep(3000);
  send(ws, 'game_stop', { game_name: 'Celeste', closed_at: new Date().toISOString() });
  await sleep(1000);
  clearInterval(hb);
  ws.close();
  log('events done');
}

async function videoOnly() {
  log('pushing test pattern for 20s without an event channel');
  const ff = spawnTestPatternPush();
  await sleep(20_000);
  ff.kill('SIGINT');
  log('video done');
}

async function flap() {
  log('flap mode: connect/disconnect every 3s for 60s');
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    try {
      const ws = await connect();
      await helloAndWelcome(ws);
      send(ws, 'game_start', { game_name: 'FlapTest', app_id: null, launched_at: new Date().toISOString() });
      await sleep(3000);
      send(ws, 'game_stop', { game_name: 'FlapTest', closed_at: new Date().toISOString() });
      ws.close();
    } catch (e) {
      log('flap iteration error', e);
    }
    await sleep(500);
  }
  log('flap done');
}

async function crash() {
  const ws = await connect();
  send(ws, 'hello', {
    client: 'dummy-producer',
    client_version: '0.0.0-test',
    deck_name: 'CrashTest',
    capabilities: [],
  });
  await sleep(100);
  log('terminating socket abruptly');
  ws.terminate();
}

async function badHandshake() {
  const ws = await connect();
  log('sending garbage as hello');
  ws.send('this is not even json');
  await sleep(500);
  ws.close();
}

const cmd = process.argv[2];
const dispatch: Record<string, () => Promise<void>> = {
  full,
  events: eventsOnly,
  video: videoOnly,
  flap,
  crash,
  'bad-handshake': badHandshake,
};

const fn = dispatch[cmd ?? ''];
if (!fn) {
  console.error('Usage: tsx test/dummy-producer/produce.ts <full|events|video|flap|crash|bad-handshake>');
  process.exit(2);
}

fn().catch((e) => {
  console.error('[dummy] fatal', e);
  process.exit(1);
});
