import { useEffect, useState } from 'react';
import { ButtonItem, PanelSectionRow } from '@decky/ui';
import { getLogs } from '../backend';

export function LogViewer({ onBack }: { onBack: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => { getLogs(200).then(setLines).catch(() => setLines(['(no logs)'])); }, []);
  return (
    <>
      <PanelSectionRow>
        <pre style={{ maxHeight: 300, overflow: 'auto', fontSize: 11 }}>{lines.join('\n')}</pre>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => { void getLogs(200).then(setLines); }}>Refresh</ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={onBack}>Back</ButtonItem>
      </PanelSectionRow>
    </>
  );
}
