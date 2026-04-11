// Window module: pure title formatter + BrowserWindow factory.
// formatTitle is pure (tested in test/unit/window-title.test.ts); createDiscdeckWindow
// owns the actual BrowserWindow with close-to-tray, aspect lock, and title updates.

import type { StreamStateSnapshot } from './state/stream-state.js';
import { BrowserWindow, app } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export function formatTitle(s: StreamStateSnapshot): string {
  const PREFIX = '🎮 Steam Deck';

  if (!s.deckConnected) return `${PREFIX} (waiting)`;
  if (s.currentGame === null) return PREFIX;

  const base = `${PREFIX} — ${s.currentGame}`;

  switch (s.state) {
    case 'connecting':
      return `${base} (connecting…)`;
    case 'error':
      return `${base} (error)`;
    case 'idle':
    case 'live':
    default:
      return base;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DiscdeckWindow {
  window: BrowserWindow;
  setTitleFromState(snapshot: StreamStateSnapshot): void;
  show(): void;
  hide(): void;
  destroy(): void;
}

export interface CreateWindowOptions {
  preloadPath?: string;
  rendererUrl?: string;
}

export function createDiscdeckWindow(opts: CreateWindowOptions = {}): DiscdeckWindow {
  // electron-vite outputs the preload as an ES module (.mjs) because the
  // project has "type": "module" and the preload is a separate build target.
  const preloadPath = opts.preloadPath ?? join(__dirname, '../preload/index.mjs');
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    show: false,
    title: '🎮 Steam Deck (waiting)',
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: true would silently break the preload because Electron's
      // sandbox mode does not support ES-module (.mjs) preload scripts, and
      // electron-vite outputs the preload as .mjs (project is "type":"module").
      // contextIsolation + nodeIntegration:false is sufficient for our threat
      // model — the renderer only loads first-party content, never untrusted
      // remote pages. Revisit if/when Electron gains sandboxed ESM preload
      // support, or switch the preload build target to CommonJS.
      sandbox: false,
    },
  });

  // Lock 16:10 aspect ratio (Steam Deck native).
  window.setAspectRatio(16 / 10);

  // Close-to-tray: intercept the close event unless the app is actually quitting.
  let allowClose = false;
  window.on('close', (e) => {
    if (!allowClose) {
      e.preventDefault();
      window.hide();
    }
  });

  app.on('before-quit', () => {
    allowClose = true;
  });

  if (opts.rendererUrl) {
    window.loadURL(opts.rendererUrl);
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return {
    window,
    setTitleFromState(snapshot) {
      window.setTitle(formatTitle(snapshot));
    },
    show() {
      window.show();
      window.focus();
    },
    hide() {
      window.hide();
    },
    destroy() {
      allowClose = true;
      if (!window.isDestroyed()) window.destroy();
    },
  };
}
