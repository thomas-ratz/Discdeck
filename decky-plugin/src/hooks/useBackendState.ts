import { useEffect, useState } from 'react';
import { AppState, getState, subscribeState } from '../backend';

/**
 * Subscribes to backend state_changed events. On mount, loads the initial
 * snapshot via get_state(). Undefined until the initial snapshot arrives.
 */
export function useBackendState(): AppState | undefined {
  const [state, setState] = useState<AppState | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    getState().then((s) => { if (!cancelled) setState(s); }).catch(() => { /* ignore */ });
    const unsub = subscribeState((s) => setState(s));
    return () => { cancelled = true; unsub(); };
  }, []);
  return state;
}
