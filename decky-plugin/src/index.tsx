import React, { useState } from 'react';
import { definePlugin } from '@decky/api';
import { PanelSection, PanelSectionRow, ButtonItem, staticClasses } from '@decky/ui';
import { FaGamepad } from 'react-icons/fa';

import { useBackendState } from './hooks/useBackendState';
import { onGameEvent } from './backend';
import { StatusLine } from './components/StatusLine';
import { CurrentGame } from './components/CurrentGame';
import { StreamToggle } from './components/StreamToggle';
import { PCAddressSubmenu } from './components/PCAddressSubmenu';
import { SettingsSubmenu } from './components/SettingsSubmenu';
import { LogViewer } from './components/LogViewer';

type View = 'main' | 'pc-address' | 'settings' | 'logs';

function Content() {
  const s = useBackendState();
  const [view, setView] = useState<View>('main');
  if (!s) return <PanelSectionRow>Loading…</PanelSectionRow>;

  if (view === 'pc-address') return <PCAddressSubmenu s={s} onBack={() => setView('main')} />;
  if (view === 'settings') return <SettingsSubmenu onBack={() => setView('main')} onOpenLogs={() => setView('logs')} />;
  if (view === 'logs') return <LogViewer onBack={() => setView('settings')} />;

  return (
    <>
      <StatusLine s={s} />
      <CurrentGame s={s} />
      <StreamToggle s={s} />
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => setView('pc-address')}>
          PC address: {s.pc_address_mode === 'auto' ? 'auto' : (s.manual_pc_address ?? 'manual')}
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => setView('settings')}>Settings</ButtonItem>
      </PanelSectionRow>
    </>
  );
}

export default definePlugin(() => {
  // SteamClient hooks — registered at plugin load, not at QAM mount.
  // These survive QAM open/close cycles.
  const unregisters: Array<() => void> = [];
  try {
    // SteamClient is injected by Steam and not in @decky/api types
    // @ts-ignore
    const lifetime = SteamClient.GameSessions.RegisterForAppLifetimeNotifications((info: any) => {
      const at = new Date().toISOString();
      const appId = String(info.unAppID);
      if (info.bRunning) {
        // Try to resolve the name via appStore
        let game_name: string | undefined;
        try {
          // @ts-ignore — global
          game_name = appStore.GetAppOverviewByAppID(info.unAppID)?.display_name;
        } catch { /* ignore */ }
        void onGameEvent({ kind: 'start', app_id: appId, game_name, at });
      } else {
        void onGameEvent({ kind: 'stop', app_id: appId, at });
      }
    });
    unregisters.push(() => lifetime.unregister());
  } catch (e) {
    console.warn('[discdeck] SteamClient hook registration failed:', e);
  }

  return {
    name: 'Discdeck',
    titleView: <div className={staticClasses.Title}>Discdeck</div>,
    content: (
      <PanelSection title="Discdeck">
        <Content />
      </PanelSection>
    ),
    icon: React.createElement(FaGamepad as React.FC),
    onDismount() {
      for (const u of unregisters) try { u(); } catch { /* ignore */ }
    },
  };
});
