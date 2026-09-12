import * as React from 'react';
import { Monitor, RotateCw, Smartphone, Tablet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  defaultOrientationForPreset,
  getDevicePreset,
  orientSize,
} from '@/features/preview/previewDevices';
import type { WorkbenchPanel } from './types';

interface DevicePreviewPanelProps {
  panel: WorkbenchPanel;
  onUpdate: (patch: Partial<WorkbenchPanel>) => void;
}

const PICKER_IDS = [
  'iphone-se',
  'iphone-15',
  'iphone-15-pro-max',
  'pixel',
  'ipad-mini',
  'ipad-pro-11',
  'ipad-pro-13',
  'small-laptop',
  'macbook',
  'desktop-1080',
  'desktop-1440',
  'custom',
] as const;

/**
 * Separate Workbench tab/panel that shows one device viewport at exact CSS sizes.
 * Visual zoom uses transform:scale so media queries still see real width/height.
 */
export function DevicePreviewPanel({ panel, onUpdate }: DevicePreviewPanelProps) {
  const deviceId = panel.settings.previewDeviceId || 'iphone-15';
  const preset = getDevicePreset(deviceId);
  const orientation =
    panel.settings.previewOrientation || defaultOrientationForPreset(preset);
  const showFrame = panel.settings.previewShowFrame !== false;
  const zoom = Math.min(1, Math.max(0.25, Number(panel.settings.previewZoom || 0.5)));
  const doc = panel.settings.previewDocument || '<!doctype html><html><body><p>No content</p></body></html>';
  const label = panel.settings.previewLabel || 'Preview';

  const logical = orientSize(preset, orientation, 390, 844, 800, 600);

  const patch = (next: Record<string, unknown>) => {
    onUpdate({ settings: { ...panel.settings, ...next } });
  };

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
  const scaledW = Math.round(logical.width * zoom);
  const scaledH = Math.round(logical.height * zoom);

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
              patch({
                previewDeviceId: e.target.value,
                previewOrientation: defaultOrientationForPreset(next),
              });
            }}
          >
            {PICKER_IDS.map((id) => {
              const d = getDevicePreset(id);
              return (
                <option key={id} value={id}>
                  {d.name} ({d.width > 0 ? `${d.width}×${d.height}` : 'fluid'})
                </option>
              );
            })}
          </select>
        </label>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Rotate"
          title="Portrait / landscape"
          onClick={() =>
            patch({ previewOrientation: orientation === 'portrait' ? 'landscape' : 'portrait' })
          }
        >
          <RotateCw />
        </Button>
        <label className="workbench-editor-field">
          <span className="sr-only">Zoom</span>
          <select
            aria-label="Zoom"
            value={String(zoom)}
            onChange={(e) => patch({ previewZoom: Number(e.target.value) })}
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
          {' · '}
          zoom {Math.round(zoom * 100)}%
        </span>
      </div>

      <div className="workbench-device-preview-stage">
        <div
          className="workbench-device-preview-shell"
          data-frame={showFrame ? 'true' : 'false'}
          data-category={preset.category}
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
            <iframe
              title={`${preset.name} preview`}
              className="workbench-device-preview-iframe"
              sandbox="allow-scripts allow-same-origin"
              referrerPolicy="no-referrer"
              srcDoc={doc}
              style={{
                width: logical.width,
                height: logical.height,
                transform: `scale(${zoom})`,
                transformOrigin: 'top left',
              }}
            />
          </div>
        </div>
        <p className="workbench-device-preview-hint">
          Exact CSS viewport {logical.width}×{logical.height}. Zoom only scales the display — not the
          layout size reported to the page.
        </p>
      </div>
    </div>
  );
}
