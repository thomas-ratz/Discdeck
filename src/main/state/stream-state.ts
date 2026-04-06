export type StreamState = 'idle' | 'connecting' | 'live' | 'error';

export type StreamEvent =
  | { type: 'deck_connected' }
  | { type: 'deck_disconnected' }
  | { type: 'stream_starting' }
  | { type: 'video_chunk_received' }
  | { type: 'stream_stopped' }
  | { type: 'ffmpeg_crashed'; at: number }
  | { type: 'reconnect' };

export interface StreamStateSnapshot {
  state: StreamState;
  deckConnected: boolean;
  currentGame: string | null;
  errorReason: string | null;
}

export interface StreamStateMachine extends StreamStateSnapshot {
  send(event: StreamEvent): StreamStateSnapshot;
  setGame(game: string | null): void;
  setError(reason: string | null): void;
  snapshot(): StreamStateSnapshot;
}

const CRASH_LOOP_THRESHOLD = 3;
const CRASH_LOOP_WINDOW_MS = 30_000;

export function createStreamState(): StreamStateMachine {
  let state: StreamState = 'idle';
  let deckConnected = false;
  let currentGame: string | null = null;
  let errorReason: string | null = null;
  let crashTimestamps: number[] = [];

  function snapshot(): StreamStateSnapshot {
    return { state, deckConnected, currentGame, errorReason };
  }

  function recordCrash(at: number): boolean {
    crashTimestamps = crashTimestamps.filter((t) => at - t < CRASH_LOOP_WINDOW_MS);
    crashTimestamps.push(at);
    return crashTimestamps.length >= CRASH_LOOP_THRESHOLD;
  }

  function send(event: StreamEvent): StreamStateSnapshot {
    if (event.type === 'reconnect') {
      state = 'idle';
      errorReason = null;
      crashTimestamps = [];
      return snapshot();
    }

    if (state === 'error') {
      // sticky; only `reconnect` can leave error state
      return snapshot();
    }

    switch (event.type) {
      case 'deck_connected':
        deckConnected = true;
        break;
      case 'deck_disconnected':
        deckConnected = false;
        if (state === 'live' || state === 'connecting') state = 'idle';
        break;
      case 'stream_starting':
        if (deckConnected && state === 'idle') state = 'connecting';
        break;
      case 'video_chunk_received':
        if (state === 'connecting') state = 'live';
        break;
      case 'stream_stopped':
        if (state === 'connecting' || state === 'live') state = 'idle';
        break;
      case 'ffmpeg_crashed': {
        const tripped = recordCrash(event.at);
        if (tripped) {
          state = 'error';
          errorReason = 'FFmpeg crashed 3+ times in 30s. Click Reconnect.';
        } else {
          if (state === 'connecting' || state === 'live') state = 'idle';
        }
        break;
      }
    }

    return snapshot();
  }

  return {
    get state() {
      return state;
    },
    get deckConnected() {
      return deckConnected;
    },
    get currentGame() {
      return currentGame;
    },
    get errorReason() {
      return errorReason;
    },
    send,
    snapshot,
    setGame(game) {
      currentGame = game;
    },
    setError(reason) {
      errorReason = reason;
      if (reason !== null) state = 'error';
    },
  };
}
