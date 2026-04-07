import React from 'react';
import type { RendererState } from '@shared/ipc-types';

export interface IdleSplashProps {
  state: RendererState;
}

export default function IdleSplash({ state }: IdleSplashProps): React.ReactElement {
  if (state.state === 'error') {
    return (
      <div className="splash error">
        <div className="brand">🎮 Discdeck</div>
        <div className="subtitle">{state.errorReason ?? 'Unknown error'}</div>
      </div>
    );
  }

  if (state.state === 'connecting') {
    const game = state.currentGame ?? 'Steam Deck';
    return (
      <div className="splash">
        <div className="brand">🎮 Discdeck</div>
        <div className="subtitle">
          Connecting to {game}…<span className="spinner" />
        </div>
      </div>
    );
  }

  // idle (covers both deck-not-connected and deck-connected-no-stream)
  const subtitle = state.deckConnected
    ? state.currentGame
      ? `Ready to stream ${state.currentGame}`
      : 'Deck connected — waiting for stream'
    : 'Waiting for Steam Deck…';

  return (
    <div className="splash">
      <div className="brand">🎮 Discdeck</div>
      <div className="subtitle">
        {subtitle}
        <span className="pulse-dot" />
      </div>
    </div>
  );
}
