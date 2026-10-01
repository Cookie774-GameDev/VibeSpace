import type { TaskbarUsagePlacement } from './providerUsageTypes';
import {
  placementFromWindowPosition,
  resolveTaskbarPlacement,
  type MonitorWorkArea,
  type PhysicalDimensions,
} from './taskbarPlacement';
import { taskbarUsageStore } from './taskbarUsageStore';
import { useUIStore } from '@/stores/ui';

export const TASKBAR_USAGE_WINDOW_LABEL = 'taskbar-usage';
export const TASKBAR_USAGE_WINDOW_PATH = '/?view=taskbar-usage';
export const TASKBAR_USAGE_COLLAPSED_SIZE = { width: 320, height: 40 } as const;
export const TASKBAR_USAGE_EXPANDED_SIZE = { width: 380, height: 360 } as const;
export const TASKBAR_USAGE_DETAILS_SIZE = { width: 920, height: 640 } as const;

export function taskbarUsageWindowOptions() {
  return {
    url: TASKBAR_USAGE_WINDOW_PATH,
    title: 'VibeSpace Usage',
    width: TASKBAR_USAGE_EXPANDED_SIZE.width,
    height: TASKBAR_USAGE_EXPANDED_SIZE.height,
    minWidth: TASKBAR_USAGE_COLLAPSED_SIZE.width,
    minHeight: TASKBAR_USAGE_COLLAPSED_SIZE.height,
    maxWidth: TASKBAR_USAGE_DETAILS_SIZE.width,
    maxHeight: TASKBAR_USAGE_DETAILS_SIZE.height,
    decorations: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    shadow: false,
    focus: false,
    visible: false,
  } as const;
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function monitorShape(monitor: {
  name: string | null;
  position: { x: number; y: number };
  size: { width: number; height: number };
  workArea: {
    position: { x: number; y: number };
    size: { width: number; height: number };
  };
}): MonitorWorkArea {
  return {
    name: monitor.name ?? 'Primary',
    position: monitor.position,
    size: monitor.size,
    workArea: monitor.workArea,
  };
}

export async function resizeAndPlaceTaskbarUsageWindow(
  size: PhysicalDimensions,
  saved: TaskbarUsagePlacement | null,
): Promise<void> {
  if (!isTauriRuntime()) return;
  const windowApi = await import('@tauri-apps/api/window');
  const current = windowApi.getCurrentWindow();
  await resizeAndPlaceWindow(current, size, saved, windowApi.availableMonitors);
}

async function resizeAndPlaceWindow(
  target: {
    setSize(size: import('@tauri-apps/api/dpi').PhysicalSize): Promise<void>;
    setPosition(position: import('@tauri-apps/api/dpi').PhysicalPosition): Promise<void>;
  },
  size: PhysicalDimensions,
  saved: TaskbarUsagePlacement | null,
  availableMonitors: typeof import('@tauri-apps/api/window').availableMonitors,
): Promise<void> {
  const { PhysicalPosition, PhysicalSize } = await import('@tauri-apps/api/dpi');
  const monitors = (await availableMonitors()).map(monitorShape);
  const placement = resolveTaskbarPlacement({ monitors, saved, windowSize: size });
  await target.setSize(new PhysicalSize(size.width, size.height));
  await target.setPosition(new PhysicalPosition(placement.x, placement.y));
  if (
    saved?.monitorName !== placement.monitorName ||
    saved?.edge !== placement.edge ||
    saved?.offset !== placement.offset
  ) {
    taskbarUsageStore.setPlacement(placement);
  }
}

async function persistSnappedWindowPosition(): Promise<void> {
  if (!isTauriRuntime()) return;
  const windowApi = await import('@tauri-apps/api/window');
  const current = windowApi.getCurrentWindow();
  const [position, size, monitors] = await Promise.all([
    current.outerPosition(),
    current.outerSize(),
    windowApi.availableMonitors(),
  ]);
  const shaped = monitors.map(monitorShape);
  const center = { x: position.x + size.width / 2, y: position.y + size.height / 2 };
  const monitor =
    shaped.find(
      ({ position: origin, size: bounds }) =>
        center.x >= origin.x &&
        center.x < origin.x + bounds.width &&
        center.y >= origin.y &&
        center.y < origin.y + bounds.height,
    ) ?? shaped[0];
  if (!monitor) return;
  const placement = placementFromWindowPosition({
    monitor,
    position,
    windowSize: size,
  });
  taskbarUsageStore.setPlacement(placement);
  await resizeAndPlaceTaskbarUsageWindow(size, placement);
}

export async function ensureTaskbarUsageWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const existing = await WebviewWindow.getByLabel(TASKBAR_USAGE_WINDOW_LABEL);
  if (existing) {
    await existing.show();
    return;
  }
  const child = new WebviewWindow(TASKBAR_USAGE_WINDOW_LABEL, taskbarUsageWindowOptions());
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error('Taskbar usage window creation timed out.')),
      4_000,
    );
    void child.once('tauri://created', () => {
      window.clearTimeout(timeout);
      resolve();
    });
    void child.once('tauri://error', (event) => {
      window.clearTimeout(timeout);
      reject(new Error(String(event.payload ?? 'Taskbar usage window creation failed.')));
    });
  });
  const windowApi = await import('@tauri-apps/api/window');
  await resizeAndPlaceWindow(
    child,
    taskbarUsageStore.getSnapshot().preferences.collapsed
      ? TASKBAR_USAGE_COLLAPSED_SIZE
      : TASKBAR_USAGE_EXPANDED_SIZE,
    taskbarUsageStore.getSnapshot().preferences.placement,
    windowApi.availableMonitors,
  );
  await child.show();
}

export async function hideTaskbarUsageWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const existing = await WebviewWindow.getByLabel(TASKBAR_USAGE_WINDOW_LABEL);
  await existing?.hide();
}

export async function startTaskbarUsageSnapListener(): Promise<() => void> {
  if (!isTauriRuntime()) return () => undefined;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  let timer: number | undefined;
  return getCurrentWindow().onMoved(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void persistSnappedWindowPosition(), 180);
  });
}

export async function requestOpenConnections(providerId?: string): Promise<void> {
  if (!isTauriRuntime()) {
    window.dispatchEvent(
      new CustomEvent('jarvis:settings:tab', {
        detail: { tab: 'connections', providerId },
      }),
    );
    return;
  }
  const { emitTo } = await import('@tauri-apps/api/event');
  await emitTo('main', 'taskbar-usage://open-connections', { providerId });
}

export async function requestTaskbarUsageRefresh(providerId?: string): Promise<void> {
  if (!isTauriRuntime()) {
    window.dispatchEvent(
      new CustomEvent('taskbar-usage://refresh', {
        detail: { providerId },
      }),
    );
    return;
  }
  const { emitTo } = await import('@tauri-apps/api/event');
  await emitTo('main', 'taskbar-usage://refresh', { providerId });
}

export async function showMainWindowConnections(providerId?: string): Promise<void> {
  if (isTauriRuntime()) {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const main = await WebviewWindow.getByLabel('main');
    await main?.show();
    await main?.unminimize();
    await main?.setFocus();
  }
  useUIStore.getState().setSettingsOpen(true);
  window.dispatchEvent(
    new CustomEvent('jarvis:settings:tab', {
      detail: { tab: 'connections', providerId },
    }),
  );
}
