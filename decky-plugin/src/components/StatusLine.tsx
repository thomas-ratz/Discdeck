import { PanelSectionRow } from '@decky/ui';
import { AppState } from '../backend';

const dot = (color: string) => (
  <span style={{ color, marginRight: 6 }}>●</span>
);

export function StatusLine({ s }: { s: AppState }) {
  let content: JSX.Element;
  switch (s.state) {
    case 'disconnected':
      content = <>{dot('#888')}Searching for PC…</>;
      break;
    case 'connecting':
      content = <>{dot('#aaa')}Connecting…</>;
      break;
    case 'connected_idle':
    case 'connected_game':
    case 'streaming':
      content = <>{dot('#22cc66')}Connected to {s.connected_pc?.server ?? 'PC'}</>;
      break;
    case 'error':
      content = <>{dot('#e33')}Error: {s.error_message ?? 'unknown'}</>;
      break;
  }
  return <PanelSectionRow>{content}</PanelSectionRow>;
}
