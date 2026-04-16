import { ToggleField } from '@decky/ui';
import { AppState, setStreamingEnabled } from '../backend';

export function StreamToggle({ s }: { s: AppState }) {
  const canStream = s.state === 'connected_idle' || s.state === 'connected_game' || s.state === 'streaming';
  return (
    <ToggleField
      label="Stream to PC"
      checked={s.streaming}
      disabled={!canStream}
      onChange={(v) => { void setStreamingEnabled(v); }}
    />
  );
}
