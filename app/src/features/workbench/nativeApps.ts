import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/lib/utils';
import type { WorkbenchPanel, WorkbenchPanelSettings } from './types';

const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const WINDOWS_EXE = /^(?:[A-Za-z]:\\|\\\\)[^\0\r\n]*\.exe$/iu;

export interface NativeAppDescriptor {
  id: string;
  name: string;
  path?: string;
  processName?: string;
  running: boolean;
  pinned: boolean;
  launchable: boolean;
}

export interface NativeAppSelection {
  appId: string;
  path?: string;
}

export interface NativeAppBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeAppSurfaceStatus {
  panelId: string;
  operationId: string;
  appId: string;
  name: string;
  embedded: boolean;
  running: boolean;
  error?: string | null;
  fallback?: boolean;
  owned?: boolean;
}

export interface NativeAppSurfaceOpenInput {
  panelId: string;
  operationId: string;
  appId: string;
  name: string;
  path?: string;
  bounds: NativeAppBounds;
  zIndex?: number;
}

export const CHATGPT_NATIVE_APP: NativeAppDescriptor = {
  id: 'chatgpt',
  name: 'ChatGPT',
  processName: 'ChatGPT.exe',
  running: false,
  pinned: true,
  launchable: true,
};

export function isSafeNativeAppPath(path: string): boolean {
  return path.length <= 2048 && WINDOWS_EXE.test(path.trim());
}

export function sanitizeNativeAppDescriptor(value: unknown): NativeAppDescriptor | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (typeof input.id !== 'string' || !APP_ID.test(input.id)) return null;
  if (typeof input.name !== 'string' || !input.name.trim()) return null;
  const path = typeof input.path === 'string' ? input.path.trim() : undefined;
  if (path && !isSafeNativeAppPath(path)) return null;
  const processName =
    typeof input.processName === 'string' && input.processName.trim()
      ? input.processName.trim().slice(0, 260)
      : undefined;
  return {
    id: input.id,
    name: input.name.trim().slice(0, 120),
    path,
    processName,
    running: input.running === true,
    pinned: input.pinned === true,
    launchable: input.launchable !== false,
  };
}

export function pinnedNativeApps(apps: readonly NativeAppDescriptor[]): NativeAppDescriptor[] {
  return apps.filter((app) => app.pinned && app.launchable);
}

export function nativeAppSelectionForPanel(panel: WorkbenchPanel): NativeAppSelection | null {
  if (panel.kind === 'ade') return { appId: 'chatgpt' };
  if (panel.kind !== 'native-app') return null;
  const rawId = panel.settings.nativeAppId?.trim();
  const rawPath = panel.settings.nativeAppPath?.trim();
  if (!rawId || !APP_ID.test(rawId)) return null;
  if (rawPath && !isSafeNativeAppPath(rawPath)) return null;
  return rawPath ? { appId: rawId, path: rawPath } : { appId: rawId };
}

export function nativeAppPanelSettings(app: NativeAppDescriptor): WorkbenchPanelSettings {
  return {
    nativeAppId: app.id,
    nativeAppName: app.name,
    ...(app.path ? { nativeAppPath: app.path } : {}),
  };
}

export async function listNativeApps(): Promise<NativeAppDescriptor[]> {
  if (!isTauri) return [];
  const raw = await invoke<unknown>('workbench_native_app_list');
  if (!Array.isArray(raw)) return [];
  return raw
    .map(sanitizeNativeAppDescriptor)
    .filter((entry): entry is NativeAppDescriptor => entry !== null);
}

export function nativeAppDescriptorFromPath(path: string): NativeAppDescriptor | null {
  const trimmed = path.trim();
  if (!isSafeNativeAppPath(trimmed)) return null;
  const fileName = trimmed.split(/[\\/]/u).pop() ?? 'App.exe';
  const name = fileName.replace(/\.exe$/iu, '').trim() || 'App';
  return {
    id: 'custom',
    name: name.slice(0, 120),
    path: trimmed,
    processName: fileName.slice(0, 260),
    running: false,
    pinned: false,
    launchable: true,
  };
}

export async function pickNativeAppExecutable(): Promise<NativeAppDescriptor | null> {
  if (!isTauri) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selection = await open({
    multiple: false,
    directory: false,
    title: 'Open app in Workbench',
    filters: [{ name: 'Windows applications', extensions: ['exe'] }],
  });
  if (typeof selection !== 'string') return null;
  const app = nativeAppDescriptorFromPath(selection);
  if (!app) throw new Error('workbench_native_app_path_invalid');
  return app;
}

export async function openNativeAppSurface(
  input: NativeAppSurfaceOpenInput,
): Promise<NativeAppSurfaceStatus> {
  if (!isTauri) throw new Error('workbench_native_app_requires_desktop');
  return invoke<NativeAppSurfaceStatus>('workbench_native_app_surface_open', { ...input });
}

export async function hideNativeAppSurface(panelId: string, operationId: string): Promise<void> {
  if (!isTauri) return;
  await invoke('workbench_native_app_surface_hide', { panelId, operationId });
}

export async function detachNativeAppSurface(panelId: string): Promise<void> {
  if (!isTauri) return;
  await invoke('workbench_native_app_surface_detach', { panelId });
}

export async function nativeAppSurfaceAction(
  panelId: string,
  operationId: string,
  action: 'status' | 'focus' | 'launch',
): Promise<NativeAppSurfaceStatus | void> {
  if (!isTauri) throw new Error('workbench_native_app_requires_desktop');
  return invoke(`workbench_native_app_surface_${action}`, { panelId, operationId });
}
