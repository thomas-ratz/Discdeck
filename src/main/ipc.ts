// IPC router: registers the main-process handlers for the typed channels
// defined in src/shared/ipc-types.ts and exposes a publish() that pushes
// state updates to the renderer. Dispose() unregisters everything on quit.

import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS, type RendererState } from '@shared/ipc-types';
import logger from './log.js';

export interface IpcRouter {
  publish(state: RendererState): void;
  dispose(): void;
}

export interface IpcRouterDeps {
  getState: () => RendererState;
  getVideoPort: () => number;
  onReconnect: () => void;
  getWindow: () => BrowserWindow | null;
}

export function createIpcRouter(deps: IpcRouterDeps): IpcRouter {
  const stateGetHandler = () => deps.getState();
  const videoPortHandler = () => deps.getVideoPort();
  const reconnectHandler = () => {
    logger.info('ipc: reconnect command received');
    deps.onReconnect();
  };

  ipcMain.handle(IPC_CHANNELS.STATE_GET, stateGetHandler);
  ipcMain.handle(IPC_CHANNELS.VIDEO_PORT, videoPortHandler);
  ipcMain.on(IPC_CHANNELS.COMMAND_RECONNECT, reconnectHandler);

  return {
    publish(state) {
      const win = deps.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.STATE_UPDATE, state);
      }
    },
    dispose() {
      ipcMain.removeHandler(IPC_CHANNELS.STATE_GET);
      ipcMain.removeHandler(IPC_CHANNELS.VIDEO_PORT);
      ipcMain.removeListener(IPC_CHANNELS.COMMAND_RECONNECT, reconnectHandler);
    },
  };
}
