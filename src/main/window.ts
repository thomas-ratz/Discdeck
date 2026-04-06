// Window module: pure title formatter (Task 3) + BrowserWindow factory (Task 10).
// This file holds only the formatter for now; createDiscdeckWindow lands in Task 10.

import type { StreamStateSnapshot } from './state/stream-state.js';

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
