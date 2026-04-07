import React, { useEffect, useState } from 'react';
import IdleSplash from './components/IdleSplash.js';
import VideoPlayer from './components/VideoPlayer.js';
import type { RendererState } from '@shared/ipc-types';

const INITIAL_STATE: RendererState = {
  state: 'idle',
  deckConnected: false,
  currentGame: null,
  errorReason: null,
};

export default function App(): React.ReactElement {
  const [state, setState] = useState<RendererState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;
    window.discdeck
      .getState()
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch((e) => console.error('initial getState failed', e));

    const unsubscribe = window.discdeck.onStateUpdate((s) => {
      if (!cancelled) setState(s);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return (
    <div className="discdeck-root">
      {state.state === 'live' ? <VideoPlayer /> : <IdleSplash state={state} />}
    </div>
  );
}
