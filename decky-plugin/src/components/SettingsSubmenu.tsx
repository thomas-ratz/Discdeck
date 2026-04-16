import { ButtonItem, PanelSectionRow } from '@decky/ui';
import { reconnect } from '../backend';

export function SettingsSubmenu({
  onBack, onOpenLogs,
}: {
  onBack: () => void; onOpenLogs: () => void;
}) {
  return (
    <>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => { void reconnect(); }}>Reconnect now</ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={onOpenLogs}>Open logs</ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>About: Discdeck v0.1.0</PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={onBack}>Back</ButtonItem>
      </PanelSectionRow>
    </>
  );
}
