import * as React from 'react';
import { AudioLines, Check, MicOff, Volume2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  captureMicrophoneSample,
  listMicrophoneDevices,
  microphoneCaptureErrorKind,
  readMicrophonePermission,
  type MicrophoneCaptureErrorKind,
  type MicrophoneDevice,
  type MicrophonePermissionState,
  type MicrophoneTestVerdict,
} from '@/features/voice/microphoneTest';

type PanelStatus = 'idle' | 'testing' | MicrophoneTestVerdict | 'error';

const ERROR_COPY: Readonly<Record<MicrophoneCaptureErrorKind, string>> = {
  denied: 'Microphone permission was denied. Allow VibeSpace in operating-system settings.',
  no_device: 'No usable microphone was found. Connect or enable an input device and try again.',
  unavailable: 'The selected microphone is busy or unavailable. Close other audio apps and retry.',
  unsupported: 'Microphone testing is unavailable in this runtime.',
  unknown: 'The microphone test could not complete. Check the selected device and try again.',
};

function permissionLabel(permission: MicrophonePermissionState): string {
  if (permission === 'granted') return 'Permission: Granted';
  if (permission === 'denied') return 'Permission: Denied';
  if (permission === 'prompt') return 'Permission: Ask on test';
  return 'Permission: Not reported';
}

function resultCopy(status: PanelStatus, error: MicrophoneCaptureErrorKind | null): string {
  if (status === 'testing') return 'Recording a three-second sample. Speak naturally now.';
  if (status === 'pass') return 'Microphone passed. Input is clear and playback is ready.';
  if (status === 'silent')
    return 'No speech detected. Check the input device and microphone level.';
  if (status === 'noisy') return 'Background noise is too loud. Reduce noise and test again.';
  if (status === 'error' && error) return ERROR_COPY[error];
  return 'Capture a short local sample to verify permission, input level, and playback.';
}

export function MicrophoneTestPanel() {
  const [permission, setPermission] = React.useState<MicrophonePermissionState>('unsupported');
  const [devices, setDevices] = React.useState<MicrophoneDevice[]>([]);
  const [deviceId, setDeviceId] = React.useState('');
  const [status, setStatus] = React.useState<PanelStatus>('idle');
  const [error, setError] = React.useState<MicrophoneCaptureErrorKind | null>(null);
  const [level, setLevel] = React.useState(0);
  const [recordingUrl, setRecordingUrl] = React.useState<string | null>(null);
  const recordingUrlRef = React.useRef<string | null>(null);

  const replaceRecordingUrl = React.useCallback((next: string | null) => {
    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
    recordingUrlRef.current = next;
    setRecordingUrl(next);
  }, []);

  const refreshDevices = React.useCallback(async () => {
    const [nextPermission, nextDevices] = await Promise.all([
      readMicrophonePermission(),
      listMicrophoneDevices().catch(() => []),
    ]);
    setPermission(nextPermission);
    setDevices(nextDevices);
    setDeviceId((current) =>
      nextDevices.some((device) => device.deviceId === current)
        ? current
        : (nextDevices[0]?.deviceId ?? ''),
    );
  }, []);

  React.useEffect(() => {
    void refreshDevices();
    const mediaDevices = navigator.mediaDevices;
    mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => {
      mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
      if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
    };
  }, [refreshDevices]);

  const testMicrophone = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('unsupported');
      setStatus('error');
      return;
    }
    setStatus('testing');
    setError(null);
    setLevel(0);
    replaceRecordingUrl(null);
    try {
      const result = await captureMicrophoneSample({
        ...(deviceId ? { deviceId } : {}),
        onLevel: setLevel,
      });
      setLevel(result.peakLevel);
      setStatus(result.verdict);
      if (result.recording) replaceRecordingUrl(URL.createObjectURL(result.recording));
      await refreshDevices();
    } catch (captureError) {
      const kind = microphoneCaptureErrorKind(captureError);
      setPermission(kind === 'denied' ? 'denied' : permission);
      setError(kind);
      setStatus('error');
      setLevel(0);
    }
  };

  const noDevice = devices.length === 0 && permission !== 'prompt';
  const disabled = status === 'testing' || permission === 'denied' || noDevice;
  const passed = status === 'pass';

  return (
    <section className="flex flex-col gap-4" aria-labelledby="microphone-test-title">
      <div>
        <Label id="microphone-test-title">Microphone</Label>
        <p className="mt-1 text-metadata text-muted-foreground">
          This test stays on your device. It records three seconds only for immediate playback.
        </p>
      </div>

      <div className="rounded-md border border-border bg-panel p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{permissionLabel(permission)}</Badge>
          {noDevice ? (
            <Badge variant="outline" className="text-warning">
              <MicOff className="mr-1 h-3 w-3" aria-hidden />
              No microphone detected
            </Badge>
          ) : null}
          {passed ? (
            <Badge variant="outline" className="text-sage">
              <Check className="mr-1 h-3 w-3" aria-hidden />
              Pass
            </Badge>
          ) : null}
        </div>

        {devices.length > 0 ? (
          <div className="mt-4">
            <Label htmlFor="microphone-test-device">Input device</Label>
            <select
              id="microphone-test-device"
              value={deviceId}
              onChange={(event) => {
                setDeviceId(event.target.value);
                setStatus('idle');
                setError(null);
                replaceRecordingUrl(null);
              }}
              disabled={status === 'testing'}
              className="mt-2 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="mt-4">
          <div className="flex items-center justify-between text-metadata">
            <span>Live input level</span>
            <span>{Math.round(level * 100)}%</span>
          </div>
          <div
            role="progressbar"
            aria-label="Live microphone input level"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(level * 100)}
            className="mt-2 h-2 overflow-hidden rounded-full bg-border"
          >
            <div
              className="h-full bg-accent-cyan transition-[width] duration-75 motion-reduce:transition-none"
              style={{ width: `${Math.round(level * 100)}%` }}
            />
          </div>
        </div>

        <p className="mt-3 min-h-5 text-metadata text-muted-foreground" aria-live="polite">
          {resultCopy(status, error)}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void testMicrophone()}
            disabled={disabled}
          >
            <AudioLines className="h-3.5 w-3.5" aria-hidden />
            {status === 'testing' ? 'Testing…' : 'Test microphone'}
          </Button>
          {recordingUrl ? (
            <div className="flex min-w-0 items-center gap-2">
              <Volume2 className="h-4 w-4 shrink-0 text-accent-cyan" aria-hidden />
              <audio
                controls
                src={recordingUrl}
                aria-label="Play microphone test recording"
                className="h-9 max-w-full"
              />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
