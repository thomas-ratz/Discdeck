// Preload: the single file allowed to call contextBridge.exposeInMainWorld.
// Exposes a typed DiscdeckBridge on window.discdeck for the renderer.

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type RendererState, type DiscdeckBridge } from '@shared/ipc-types';

const bridge: DiscdeckBridge = {
  getState: () => ipcRenderer.invoke(IPC_CHANNELS.STATE_GET) as Promise<RendererState>,
  onStateUpdate: (cb) => {
    const listener = (_event: unknown, state: RendererState) => cb(state);
    ipcRenderer.on(IPC_CHANNELS.STATE_UPDATE, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.STATE_UPDATE, listener);
    };
  },
  getVideoPort: () => ipcRenderer.invoke(IPC_CHANNELS.VIDEO_PORT) as Promise<number>,
  reconnect: () => ipcRenderer.send(IPC_CHANNELS.COMMAND_RECONNECT),
};

contextBridge.exposeInMainWorld('discdeck', bridge);
