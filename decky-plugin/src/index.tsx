import { definePlugin } from '@decky/api';
import { PanelSection } from '@decky/ui';

export default definePlugin(() => ({
  name: 'Discdeck',
  content: <PanelSection title="Discdeck" />,
  onDismount() {},
}));
