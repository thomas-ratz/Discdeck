import { useState } from 'react';
import { ButtonItem, PanelSectionRow, TextField } from '@decky/ui';
import { AppState, setPCAddressMode } from '../backend';

export function PCAddressSubmenu({ s, onBack }: { s: AppState; onBack: () => void }) {
  const [manual, setManual] = useState(s.manual_pc_address ?? '');
  return (
    <>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => { void setPCAddressMode({ mode: 'auto' }); }}>
          Auto-detect (mDNS) {s.pc_address_mode === 'auto' && '✓'}
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <TextField label="Manual PC address" value={manual} onChange={(e) => setManual(e.target.value)} />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => { void setPCAddressMode({ mode: 'manual', address: manual }); }}>
          Use manual address
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={onBack}>Back</ButtonItem>
      </PanelSectionRow>
    </>
  );
}
