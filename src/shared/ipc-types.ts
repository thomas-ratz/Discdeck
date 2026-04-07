// Shared IPC types between main, preload, and renderer. The only file
// imported from BOTH src/main and src/renderer — keeps the wire contract
// in one place and enforces boundary rule 1 (no raw network data crosses
// IPC, only state snapshots and small commands).

export type RendererStreamState = 'idle' | 'connecting' | 'live' | 'error';

export interface RendererState {
  state: RendererStreamState;
  deckConnected: boolean;
  currentGame: string | null;
  errorReason: string | null;
}

export const IPC_CHANNELS = {
  STATE_UPDATE: 'state:update',
  STATE_GET: 'state:get',
  VIDEO_PORT: 'video:port',
  COMMAND_RECONNECT: 'command:reconnect',
} as const;

export interface DiscdeckBridge {
  getState(): Promise<RendererState>;
  onStateUpdate(cb: (state: RendererState) => void): () => void;
  getVideoPort(): Promise<number>;
  reconnect(): void;
}

declare global {
  interface Window {
    discdeck: DiscdeckBridge;
  }
}
