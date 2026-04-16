import { call, addEventListener, removeEventListener } from '@decky/api';

export type State = 'disconnected' | 'connecting' | 'connected_idle' | 'connected_game' | 'streaming' | 'error';

export interface GameRef { app_id: string; game_name: string; }

export interface ConnectedPC {
  server: string;
  address: string;
  event_port: number;
  rtsp_port: number;
}

export interface AppState {
  state: State;
  connected_pc: ConnectedPC | null;
  current_game: GameRef | null;
  streaming: boolean;
  error_message: string | null;
  pc_address_mode: 'auto' | 'manual';
  manual_pc_address: string | null;
}

export const getState = () => call<[], AppState>('get_state');
export const setStreamingEnabled = (on: boolean) => call<[boolean], AppState>('set_streaming_enabled', on);
export const onGameEvent = (args: { kind: 'start' | 'stop'; app_id: string; game_name?: string; at: string }) =>
  call<[typeof args], void>('on_game_event', args);
export const setPCAddressMode = (args: { mode: 'auto' | 'manual'; address?: string | null }) =>
  call<[typeof args], void>('set_pc_address_mode', args);
export const reconnect = () => call<[], void>('reconnect');
export const getLogs = (lines: number = 200) => call<[{ lines: number }], string[]>('get_logs', { lines });

export type StateChangedListener = (state: AppState) => void;
export const subscribeState = (cb: StateChangedListener) => {
  addEventListener('state_changed', cb);
  return () => removeEventListener('state_changed', cb);
};
