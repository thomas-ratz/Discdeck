import { describe, it, expect } from 'vitest';
import { createStreamState } from '../../src/main/state/stream-state.js';

describe('stream-state', () => {
  it('starts in idle with no deck and no game', () => {
    const sm = createStreamState();
    expect(sm.state).toBe('idle');
    expect(sm.deckConnected).toBe(false);
    expect(sm.currentGame).toBeNull();
  });
});

describe('stream-state transitions', () => {
  it('deck_connected sets the connected flag without changing state', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    expect(sm.state).toBe('idle');
    expect(sm.deckConnected).toBe(true);
  });

  it('stream_starting goes idle → connecting only when deck is connected', () => {
    const sm = createStreamState();
    sm.send({ type: 'stream_starting' }); // ignored — no deck
    expect(sm.state).toBe('idle');
    sm.send({ type: 'deck_connected' });
    sm.send({ type: 'stream_starting' });
    expect(sm.state).toBe('connecting');
  });

  it('first video_chunk_received goes connecting → live', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'video_chunk_received' });
    expect(sm.state).toBe('live');
  });

  it('stream_stopped from live goes back to idle', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'video_chunk_received' });
    sm.send({ type: 'stream_stopped' });
    expect(sm.state).toBe('idle');
  });

  it('deck_disconnected from live goes back to idle and clears flag', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'video_chunk_received' });
    sm.send({ type: 'deck_disconnected' });
    expect(sm.state).toBe('idle');
    expect(sm.deckConnected).toBe(false);
  });

  it('stream_stopped from connecting (cancelled before video) goes idle', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'stream_stopped' });
    expect(sm.state).toBe('idle');
  });
});

describe('stream-state crash-loop guard', () => {
  it('two crashes within window stay in idle and do not trip', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'video_chunk_received' });
    sm.send({ type: 'ffmpeg_crashed', at: 1000 });
    expect(sm.state).toBe('idle');
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'video_chunk_received' });
    sm.send({ type: 'ffmpeg_crashed', at: 2000 });
    expect(sm.state).toBe('idle');
  });

  it('three crashes within 30s window trip the guard to error', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    for (let i = 0; i < 3; i++) {
      sm.send({ type: 'stream_starting' });
      sm.send({ type: 'video_chunk_received' });
      sm.send({ type: 'ffmpeg_crashed', at: 1000 + i * 1000 });
    }
    expect(sm.state).toBe('error');
    expect(sm.errorReason).toMatch(/3\+ times/);
  });

  it('three crashes spread over more than 30s do not trip', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'video_chunk_received' });
    sm.send({ type: 'ffmpeg_crashed', at: 0 });
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'video_chunk_received' });
    sm.send({ type: 'ffmpeg_crashed', at: 20_000 });
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'video_chunk_received' });
    sm.send({ type: 'ffmpeg_crashed', at: 50_000 }); // first crash now outside window
    expect(sm.state).toBe('idle');
  });

  it('reconnect from error returns to idle and resets crash counter', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    for (let i = 0; i < 3; i++) {
      sm.send({ type: 'stream_starting' });
      sm.send({ type: 'video_chunk_received' });
      sm.send({ type: 'ffmpeg_crashed', at: 1000 + i * 1000 });
    }
    expect(sm.state).toBe('error');
    sm.send({ type: 'reconnect' });
    expect(sm.state).toBe('idle');
    expect(sm.errorReason).toBeNull();
  });

  it('error state is sticky to non-reconnect events', () => {
    const sm = createStreamState();
    sm.setError('test');
    sm.send({ type: 'deck_connected' });
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'video_chunk_received' });
    expect(sm.state).toBe('error');
  });
});

describe('stream-state setGame', () => {
  it('setGame updates currentGame independently of state', () => {
    const sm = createStreamState();
    sm.setGame('Hollow Knight');
    expect(sm.currentGame).toBe('Hollow Knight');
    sm.setGame(null);
    expect(sm.currentGame).toBeNull();
  });
});

describe('stream-state transition coverage', () => {
  it('ffmpeg_crashed from connecting (non-tripping) goes back to idle', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    sm.send({ type: 'stream_starting' });
    expect(sm.state).toBe('connecting');
    sm.send({ type: 'ffmpeg_crashed', at: 1000 });
    expect(sm.state).toBe('idle');
  });

  it('deck_disconnected from connecting goes back to idle and clears flag', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'deck_disconnected' });
    expect(sm.state).toBe('idle');
    expect(sm.deckConnected).toBe(false);
  });

  it('reconnect clears error set via setError', () => {
    const sm = createStreamState();
    sm.setError('manual');
    expect(sm.state).toBe('error');
    sm.send({ type: 'reconnect' });
    expect(sm.state).toBe('idle');
    expect(sm.errorReason).toBeNull();
  });

  it('snapshot() returns a plain object matching current getters', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    sm.setGame('Hollow Knight');
    const snap = sm.snapshot();
    expect(snap).toEqual({
      state: 'idle',
      deckConnected: true,
      currentGame: 'Hollow Knight',
      errorReason: null,
    });
  });

  it('send() returns the post-transition snapshot', () => {
    const sm = createStreamState();
    const snap = sm.send({ type: 'deck_connected' });
    expect(snap.deckConnected).toBe(true);
    expect(snap.state).toBe('idle');
  });
});
