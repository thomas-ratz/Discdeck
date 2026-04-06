import { describe, it, expect } from 'vitest';
import { formatTitle } from '../../src/main/window.js';

describe('formatTitle', () => {
  it('returns waiting title when no deck is connected', () => {
    expect(
      formatTitle({
        state: 'idle',
        deckConnected: false,
        currentGame: null,
        errorReason: null,
      }),
    ).toBe('🎮 Steam Deck (waiting)');
  });
});

describe('formatTitle — all spec rows', () => {
  const base = {
    deckConnected: true as const,
    errorReason: null,
  };

  it('deck connected, no game → "🎮 Steam Deck"', () => {
    expect(
      formatTitle({ ...base, state: 'idle', currentGame: null }),
    ).toBe('🎮 Steam Deck');
  });

  it('deck connected, game known, idle → "🎮 Steam Deck — Hollow Knight"', () => {
    expect(
      formatTitle({ ...base, state: 'idle', currentGame: 'Hollow Knight' }),
    ).toBe('🎮 Steam Deck — Hollow Knight');
  });

  it('connecting → adds "(connecting…)" suffix', () => {
    expect(
      formatTitle({ ...base, state: 'connecting', currentGame: 'Hollow Knight' }),
    ).toBe('🎮 Steam Deck — Hollow Knight (connecting…)');
  });

  it('live → no suffix (same as idle with game)', () => {
    expect(
      formatTitle({ ...base, state: 'live', currentGame: 'Hollow Knight' }),
    ).toBe('🎮 Steam Deck — Hollow Knight');
  });

  it('error with game → adds "(error)" suffix', () => {
    expect(
      formatTitle({ ...base, state: 'error', currentGame: 'Hollow Knight' }),
    ).toBe('🎮 Steam Deck — Hollow Knight (error)');
  });

  it('all titles begin with the invariant prefix', () => {
    const cases = [
      { state: 'idle', deckConnected: false, currentGame: null, errorReason: null },
      { state: 'idle', deckConnected: true, currentGame: null, errorReason: null },
      { state: 'live', deckConnected: true, currentGame: 'Hades', errorReason: null },
      { state: 'error', deckConnected: true, currentGame: 'Hades', errorReason: 'x' },
    ] as const;
    for (const c of cases) {
      expect(formatTitle(c).startsWith('🎮 Steam Deck')).toBe(true);
    }
  });
});
