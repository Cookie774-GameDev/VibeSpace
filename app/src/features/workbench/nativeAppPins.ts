import { sanitizeNativeAppDescriptor, type NativeAppDescriptor } from './nativeApps';

export function nativeAppPinKey(app: NativeAppDescriptor): string {
  return app.id === 'custom' ? `path:${app.path?.toLowerCase()}` : app.id;
}

export function readNativeAppPins(raw: string | null): NativeAppDescriptor[] {
  try {
    const values: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(values)
      ? values.map(sanitizeNativeAppDescriptor).filter((app): app is NativeAppDescriptor => !!app)
      : [];
  } catch {
    return [];
  }
}

export function updateNativeAppPin(
  pins: readonly NativeAppDescriptor[],
  app: NativeAppDescriptor,
): NativeAppDescriptor[] {
  const key = nativeAppPinKey(app);
  return [
    ...pins.filter((entry) => nativeAppPinKey(entry) !== key),
    { ...app, pinned: !app.pinned },
  ];
}

export function mergeNativeAppPins(
  apps: readonly NativeAppDescriptor[],
  pins: readonly NativeAppDescriptor[],
): NativeAppDescriptor[] {
  const overrides = new Map(pins.map((app) => [nativeAppPinKey(app), app]));
  const result = apps.map((app) => {
    const saved = overrides.get(nativeAppPinKey(app));
    overrides.delete(nativeAppPinKey(app));
    return saved ? { ...app, pinned: saved.pinned } : app;
  });
  for (const app of overrides.values()) {
    if (app.pinned) result.push({ ...app, running: false, launchable: app.id === 'custom' });
  }
  return result;
}
