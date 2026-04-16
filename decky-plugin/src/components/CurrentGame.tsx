import { PanelSectionRow } from '@decky/ui';
import { AppState } from '../backend';

export function CurrentGame({ s }: { s: AppState }) {
  return (
    <PanelSectionRow>
      Game: {s.current_game?.game_name ?? 'None'}
    </PanelSectionRow>
  );
}
