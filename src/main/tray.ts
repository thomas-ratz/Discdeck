// Tray controller: renders state-driven tray icons (idle/ready/live/error),
// builds a context menu with live info rows and actions, and fires throttled
// OS notifications on state transitions. Consumer is src/main/index.ts (Task 12).

import { Tray, Menu, Notification, nativeImage, BrowserWindow, shell, app } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import logger from './log.js';
import type { RendererState } from '@shared/ipc-types';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type TrayIconState = 'idle' | 'ready' | 'live' | 'error';

export interface TrayController {
  setState(state: RendererState): void;
  setAlwaysOnTop(on: boolean): void;
  destroy(): void;
}

export interface TrayDeps {
  getWindow: () => BrowserWindow | null;
  onReconnect: () => void;
  onQuit: () => void;
  onToggleAlwaysOnTop: (on: boolean) => void;
}

const NOTIFY_THROTTLE_MS = 10_000;

function iconPath(name: TrayIconState): string {
  // electron-vite outputs main bundle to out/main, so resources/ is two levels up
  return join(__dirname, '..', '..', 'resources', 'icons', `tray-${name}.png`);
}

function pickIcon(state: RendererState): TrayIconState {
  if (state.state === 'error') return 'error';
  if (state.state === 'live' || state.state === 'connecting') return 'live';
  if (state.deckConnected) return 'ready';
  return 'idle';
}

export function createTray(deps: TrayDeps): TrayController {
  const tray = new Tray(nativeImage.createFromPath(iconPath('idle')));
  tray.setToolTip('Discdeck — waiting for Steam Deck');

  let lastState: RendererState = {
    state: 'idle',
    deckConnected: false,
    currentGame: null,
    errorReason: null,
  };
  let alwaysOnTop = false;
  const lastNotificationAt: Record<string, number> = {};

  function notify(key: string, title: string, body: string) {
    const now = Date.now();
    if (lastNotificationAt[key] && now - lastNotificationAt[key] < NOTIFY_THROTTLE_MS) return;
    lastNotificationAt[key] = now;
    try {
      new Notification({ title, body }).show();
    } catch (e) {
      logger.warn('tray: notification failed', e);
    }
  }

  function buildMenu(): Menu {
    const streamingLabel =
      lastState.state === 'live'
        ? `● Streaming: ${lastState.currentGame ?? 'Steam Deck'}`
        : lastState.state === 'connecting'
          ? `○ Connecting: ${lastState.currentGame ?? 'Steam Deck'}`
          : lastState.state === 'error'
            ? `✕ Error: ${lastState.errorReason ?? 'unknown'}`
            : '○ Idle';
    const deckLabel = lastState.deckConnected ? '● Deck connected' : '○ No Deck connected';

    return Menu.buildFromTemplate([
      { label: streamingLabel, enabled: false },
      { label: deckLabel, enabled: false },
      { type: 'separator' },
      {
        label: 'Show window',
        click: () => {
          const win = deps.getWindow();
          if (win) {
            win.show();
            win.focus();
          }
        },
      },
      {
        label: 'Hide window',
        click: () => deps.getWindow()?.hide(),
      },
      {
        label: 'Always on top',
        type: 'checkbox',
        checked: alwaysOnTop,
        click: (item) => {
          alwaysOnTop = item.checked;
          deps.onToggleAlwaysOnTop(alwaysOnTop);
        },
      },
      { type: 'separator' },
      { label: 'Reconnect', click: () => deps.onReconnect() },
      {
        label: 'Open log folder',
        click: () => {
          const logDir = app.getPath('logs');
          shell.openPath(logDir);
        },
      },
      { type: 'separator' },
      { label: 'About Discdeck', enabled: false },
      { label: 'Quit Discdeck', click: () => deps.onQuit() },
    ]);
  }

  function refresh() {
    const icon = pickIcon(lastState);
    tray.setImage(nativeImage.createFromPath(iconPath(icon)));
    let tip = 'Discdeck — waiting for Steam Deck';
    if (lastState.state === 'error') tip = 'Discdeck — error (click for details)';
    else if (lastState.state === 'live') tip = `Discdeck — streaming ${lastState.currentGame ?? 'Steam Deck'}`;
    else if (lastState.deckConnected) tip = 'Discdeck — Deck connected';
    tray.setToolTip(tip);
    tray.setContextMenu(buildMenu());
  }

  refresh();

  tray.on('click', () => {
    const win = deps.getWindow();
    if (!win) return;
    if (win.isVisible()) win.hide();
    else {
      win.show();
      win.focus();
    }
  });

  return {
    setState(next) {
      const wasConnected = lastState.deckConnected;
      const wasLive = lastState.state === 'live';
      const wasError = lastState.state === 'error';
      lastState = next;
      refresh();

      if (!wasConnected && next.deckConnected) {
        notify('deck_connected', 'Steam Deck connected', 'Discdeck is ready.');
      }
      if (wasConnected && !next.deckConnected) {
        notify('deck_disconnected', 'Steam Deck disconnected', 'Waiting for reconnect.');
      }
      if (!wasLive && next.state === 'live') {
        notify('stream_live', 'Now streaming', next.currentGame ?? 'Steam Deck');
      }
      if (!wasError && next.state === 'error') {
        notify('stream_error', 'Discdeck error', next.errorReason ?? 'unknown error');
      }
    },
    setAlwaysOnTop(on) {
      alwaysOnTop = on;
      refresh();
    },
    destroy() {
      tray.destroy();
    },
  };
}
