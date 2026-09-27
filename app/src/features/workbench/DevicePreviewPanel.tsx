import * as React from 'react';
import { Monitor, RotateCw, Smartphone, Tablet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  WORKBENCH_DEVICE_PRESETS,
  classifyAndroidWindow,
  defaultOrientationForPreset,
  deviceVerificationLabel,
  getDevicePreset,
  groupDevicePresets,
  orientSize,
} from '@/features/preview/previewDevices';
import type { WorkbenchPanel } from './types';
import { fitPreviewPanelInCanvas, previewPanelSize, useWorkbenchStore } from './store';

interface DevicePreviewPanelProps {
  panel: WorkbenchPanel;
  onUpdate: (patch: Partial<WorkbenchPanel>) => void;
}

/**
 * Separate Workbench tab/panel that shows one device viewport at exact CSS sizes.
 * Visual zoom uses transform:scale so media queries still see real width/height.
 */
export function DevicePreviewPanel({ panel, onUpdate }: DevicePreviewPanelProps) {
  const view = useWorkbenchStore((state) => state.view);
  const canvasSize = useWorkbenchStore((state) => state.canvasSize);
  const deviceId = panel.settings.previewDeviceId || 'iphone-15';
  const preset = getDevicePreset(deviceId);
  const orientation = panel.settings.previewOrientation || defaultOrientationForPreset(preset);
  const showFrame = panel.settings.previewShowFrame !== false;
  const zoom = Math.min(1, Math.max(0.25, Number(panel.settings.previewZoom || 0.5)));
  const doc =
    panel.settings.previewDocument || '<!doctype html><html><body><p>No content</p></body></html>';
  const label = panel.settings.previewLabel || 'Preview';

  const logical = orientSize(preset, orientation, 390, 844, 800, 600);
  const deviceGroups = groupDevicePresets(WORKBENCH_DEVICE_PRESETS);
  const androidWindow =
    preset.platform === 'android' || preset.platform === 'adaptive'
      ? classifyAndroidWindow(logical.width, logical.height)
      : null;
  const verificationLabel = deviceVerificationLabel(preset);

  const patch = (next: Record<string, unknown>) => {
    onUpdate({ settings: { ...panel.settings, ...next } });
  };
  const fittedPanel = (nextSize: { width: number; height: number }) => ({
    ...nextSize,
    ...fitPreviewPanelInCanvas(panel, nextSize, view, canvasSize),
  });

  // When device changes, retitle panel.
  React.useEffect(() => {
    const title = `${preset.name} · ${label}`.slice(0, 80);
    if (panel.title !== title) {
      onUpdate({ title });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset.name, label]);

  const categoryIcon =
    preset.category === 'phone' ? (
      <Smartphone className="h-3.5 w-3.5" />
    ) : preset.category === 'tablet' ? (
      <Tablet className="h-3.5 w-3.5" />
    ) : (
      <Monitor className="h-3.5 w-3.5" />
    );

  // Exact CSS viewport inside iframe; visual scale via transform.
  const scaledW = logical.width * zoom;
  const scaledH = logical.height * zoom;

  return (
    <div className="workbench-device-preview" data-testid="workbench-device-preview-panel">
      <div className="workbench-device-preview-toolbar">
        {categoryIcon}
        <label className="workbench-editor-field">
          <span className="sr-only">Device</span>
          <select
            aria-label="Device"
            value={deviceId}
            onChange={(e) => {
              const next = getDevicePreset(e.target.value);
              const nextOrientation = defaultOrientationForPreset(next);
              const nextZoom = next.category === 'phone' ? 1 : 0.5;
              onUpdate({
                ...fittedPanel(
                  previewPanelSize(orientSize(next, nextOrientation, 390, 844, 800, 600), nextZoom),
                ),
                settings: {
                  ...panel.settings,
                  previewDeviceId: e.target.value,
                  previewOrientation: nextOrientation,
                  previewZoom: nextZoom,
                },
              });
            }}
          >
            {deviceGroups.map((group) => (
              <optgroup key={group.id} label={group.label}>
                {group.devices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {`${device.name} (${device.width > 0 ? `${device.width}×${device.height}` : 'fluid'})`}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Rotate"
          title="Portrait / landscape"
          onClick={() => {
            const nextOrientation = orientation === 'portrait' ? 'landscape' : 'portrait';
            onUpdate({
              ...fittedPanel(
                previewPanelSize(orientSize(preset, nextOrientation, 390, 844, 800, 600), zoom),
              ),
              settings: { ...panel.settings, previewOrientation: nextOrientation },
            });
          }}
        >
          <RotateCw />
        </Button>
        <label className="workbench-editor-field">
          <span className="sr-only">Zoom</span>
          <select
            aria-label="Zoom"
            value={String(zoom)}
            onChange={(e) => {
              const nextZoom = Number(e.target.value);
              onUpdate({
                ...fittedPanel(previewPanelSize(logical, nextZoom)),
                settings: { ...panel.settings, previewZoom: nextZoom },
              });
            }}
          >
            {[0.25, 0.35, 0.5, 0.65, 0.75, 1].map((z) => (
              <option key={z} value={z}>
                {Math.round(z * 100)}%
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => patch({ previewShowFrame: !showFrame })}
        >
          {showFrame ? 'Frame on' : 'Frame off'}
        </Button>
        <span className="workbench-device-preview-size">
          CSS {logical.width}×{logical.height}
          {orientation === 'landscape' ? ' landscape' : ' portrait'}
          {' · '}
          DPR {preset.dpr}
          {preset.touch ? ' · touch' : ''}
          {androidWindow
            ? ` · Android ${androidWindow.width} width · ${androidWindow.height} height`
            : ''}
          {verificationLabel ? ` · ${verificationLabel}` : ''}
          {' · '}
          zoom {Math.round(zoom * 100)}%
        </span>
      </div>

      <div className="workbench-device-preview-stage">
        <div
          className="workbench-device-preview-shell"
          data-frame={showFrame ? 'true' : 'false'}
          data-category={preset.category}
          data-platform={preset.platform}
          data-window-width-class={androidWindow?.width}
          data-window-height-class={androidWindow?.height}
          data-dpr={preset.dpr}
        >
          {showFrame ? (
            <div className="workbench-device-preview-chrome">
              <span className="workbench-device-preview-notch" aria-hidden="true" />
              <span>
                {preset.name} · {logical.width}×{logical.height}
              </span>
            </div>
          ) : null}
          {/*
            Outer box is the *visual* size (scaled).
            Inner iframe is the *exact* CSS viewport so media queries match the device.
          */}
          <div
            className="workbench-device-preview-scale-box"
            style={{ width: scaledW, height: scaledH }}
          >
            {!panel.minimized ? (
              <iframe
                title={`${preset.name} preview`}
                className="workbench-device-preview-iframe"
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                srcDoc={doc}
                style={{
                  width: logical.width,
                  height: logical.height,
                  transform: `scale(${zoom})`,
                  transformOrigin: 'top left',
                }}
              />
            ) : null}
          </div>
        </div>
        <p className="workbench-device-preview-hint">
          Full-screen CSS viewport {logical.width}×{logical.height}. Zoom only scales the display,
          not media queries. Browser chrome and safe-area insets are not emulated. Native app
          testing uses platform tooling.
        </p>
      </div>
    </div>
  );
}
