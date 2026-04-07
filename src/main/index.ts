// Main entry: single-instance lock, app.whenReady composition of every
// module from Tasks 2-11, and before-quit cleanup sequence. This is the
// ONLY file that knows the high-level wiring; everything else exposes a
// clean module API.

import { app } from 'electron';
import logger from './log.js';
import { createStreamState, type StreamStateSnapshot } from './state/stream-state.js';
import { startEventServer, type EventServer } from './network/event-server.js';
import { createFfmpegListener, type FfmpegListener } from './network/ffmpeg-listener.js';
import { startVideoRelay, type VideoRelay } from './network/video-relay.js';
import { publishMdnsService, type MdnsService } from './network/mdns.js';
import { createDiscdeckWindow, type DiscdeckWindow } from './window.js';
import { createTray, type TrayController } from './tray.js';
import { createIpcRouter, type IpcRouter } from './ipc.js';
import type { RendererState } from '@shared/ipc-types';

const EVENT_PORT = 8765;
const RTSP_PORT = 8554;

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
  process.exit(0);
}

const state = createStreamState();
let eventServer: EventServer | null = null;
let ffmpeg: FfmpegListener | null = null;
let videoRelay: VideoRelay | null = null;
let mdns: MdnsService | null = null;
let discdeckWindow: DiscdeckWindow | null = null;
let tray: TrayController | null = null;
let ipc: IpcRouter | null = null;
let firstChunkSeenForCurrentSession = false;
let quitting = false;

function snapshot(): RendererState {
  const s = state.snapshot();
  return {
    state: s.state,
    deckConnected: s.deckConnected,
    currentGame: s.currentGame,
    errorReason: s.errorReason,
  };
}

function refreshAllUI() {
  const snap = snapshot();
  ipc?.publish(snap);
  tray?.setState(snap);
  if (discdeckWindow) {
    const fullSnap: StreamStateSnapshot = state.snapshot();
    discdeckWindow.setTitleFromState(fullSnap);
  }
}

function applyEvent(send: () => void) {
  send();
  refreshAllUI();
}

app.on('second-instance', () => {
  discdeckWindow?.show();
});

app.whenReady().then(async () => {
  logger.info('Discdeck PC starting');

  videoRelay = await startVideoRelay();
  ffmpeg = await createFfmpegListener({ port: RTSP_PORT });

  ffmpeg.onChunk((chunk) => {
    videoRelay?.push(chunk);
    if (!firstChunkSeenForCurrentSession) {
      firstChunkSeenForCurrentSession = true;
      applyEvent(() => state.send({ type: 'video_chunk_received' }));
    }
  });

  ffmpeg.onExit((info) => {
    firstChunkSeenForCurrentSession = false;
    if (quitting) return;
    if (info.normal) {
      applyEvent(() => state.send({ type: 'stream_stopped' }));
    } else {
      applyEvent(() => state.send({ type: 'ffmpeg_crashed', at: Date.now() }));
    }
    if (state.snapshot().state !== 'error') {
      // Respawn the listener so it's ready for the next push.
      ffmpeg!.start();
    }
  });

  ffmpeg.start();

  eventServer = await startEventServer({ port: EVENT_PORT });
  eventServer.setCallbacks({
    onConnected: ({ deckName }) => {
      logger.info(`Deck connected: ${deckName}`);
      applyEvent(() => state.send({ type: 'deck_connected' }));
    },
    onDisconnected: () => {
      logger.info('Deck disconnected');
      applyEvent(() => state.send({ type: 'deck_disconnected' }));
    },
    onMessage: (msg) => {
      switch (msg.type) {
        case 'game_start':
        case 'game_change': {
          const name = typeof msg.data.game_name === 'string' ? msg.data.game_name : null;
          state.setGame(name);
          refreshAllUI();
          break;
        }
        case 'game_stop':
          state.setGame(null);
          refreshAllUI();
          break;
        case 'stream_starting':
          applyEvent(() => state.send({ type: 'stream_starting' }));
          break;
        case 'stream_stopped':
          applyEvent(() => state.send({ type: 'stream_stopped' }));
          break;
        case 'error':
          logger.warn('Deck reported error:', msg.data);
          break;
      }
    },
    onError: (err) => logger.warn('event-server parse error', err),
  });

  mdns = publishMdnsService({ eventPort: EVENT_PORT, rtspPort: RTSP_PORT });

  discdeckWindow = createDiscdeckWindow({
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
  });
  // Hidden by default; tray controls visibility.
  discdeckWindow.window.once('ready-to-show', () => {
    // Do not auto-show — start hidden in tray.
  });

  ipc = createIpcRouter({
    getState: snapshot,
    getVideoPort: () => videoRelay!.port,
    onReconnect: () => {
      logger.info('reconnect requested');
      applyEvent(() => state.send({ type: 'reconnect' }));
      ffmpeg?.stop().then(() => ffmpeg?.start());
    },
    getWindow: () => discdeckWindow?.window ?? null,
  });

  tray = createTray({
    getWindow: () => discdeckWindow?.window ?? null,
    onReconnect: () => {
      logger.info('reconnect requested via tray');
      applyEvent(() => state.send({ type: 'reconnect' }));
      ffmpeg?.stop().then(() => ffmpeg?.start());
    },
    onToggleAlwaysOnTop: (on) => {
      discdeckWindow?.window.setAlwaysOnTop(on);
    },
    onQuit: () => {
      app.quit();
    },
  });

  refreshAllUI();
  logger.info('Discdeck PC ready');
});

app.on('window-all-closed', () => {
  // Tray app: do not quit when all windows close.
  // The default Electron behaviour would quit here; by doing nothing we keep
  // the process alive and let the tray control the app lifetime instead.
});

app.on('before-quit', async (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  logger.info('Discdeck PC shutting down');

  const cleanup = (async () => {
    try {
      ipc?.dispose();
    } catch (e) {
      logger.warn('ipc dispose failed', e);
    }
    try {
      await eventServer?.stop();
    } catch (e) {
      logger.warn('event-server stop failed', e);
    }
    try {
      await ffmpeg?.stop();
    } catch (e) {
      logger.warn('ffmpeg stop failed', e);
    }
    try {
      await videoRelay?.stop();
    } catch (e) {
      logger.warn('video-relay stop failed', e);
    }
    try {
      await mdns?.stop();
    } catch (e) {
      logger.warn('mdns stop failed', e);
    }
    try {
      tray?.destroy();
    } catch (e) {
      logger.warn('tray destroy failed', e);
    }
    try {
      discdeckWindow?.destroy();
    } catch (e) {
      logger.warn('window destroy failed', e);
    }
  })();

  await Promise.race([
    cleanup,
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);

  logger.info('Discdeck PC stopped');
  app.exit(0);
});
