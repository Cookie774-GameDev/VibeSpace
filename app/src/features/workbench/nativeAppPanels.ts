import { useWorkbenchStore } from './store';
import {
  nativeAppPanelSettings,
  sanitizeNativeAppDescriptor,
  requestNativeAppLaunch,
  type NativeAppDescriptor,
} from './nativeApps';

export function openNativeAppPanel(input: NativeAppDescriptor): string | null {
  const app = sanitizeNativeAppDescriptor(input);
  if (!app || !app.launchable) return null;
  const store = useWorkbenchStore.getState();
  const existing = store.panels.find((panel) => {
    if (app.id === 'chatgpt' && panel.kind === 'ade') return true;
    if (panel.kind !== 'native-app') return false;
    if (panel.settings.nativeAppId !== app.id) return false;
    return app.path ? panel.settings.nativeAppPath === app.path : !panel.settings.nativeAppPath;
  });
  const settings = nativeAppPanelSettings(app);
  if (existing) {
    requestNativeAppLaunch(existing.id);
    store.updatePanel(existing.id, {
      kind: 'native-app',
      title: app.name,
      minimized: false,
      status: 'idle',
      settings: { ...existing.settings, ...settings },
    });
    store.bringToFront(existing.id);
    store.selectPanel(existing.id);
    store.fitView();
    return existing.id;
  }
  const id = store.addPanel('native-app', undefined, settings);
  if (!id) return null;
  requestNativeAppLaunch(id);
  useWorkbenchStore.getState().updatePanel(id, { title: app.name, status: 'idle' });
  useWorkbenchStore.getState().bringToFront(id);
  useWorkbenchStore.getState().selectPanel(id);
  useWorkbenchStore.getState().fitView();
  return id;
}
