import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth';
import { getStoredProjectRoot } from '@/features/files/projectFiles';
import type { NativeRuntimeDetection } from '@/lib/harness/runtimeManager';
import type { LeafBase } from '@/features/terminals/paneTree';

export function DirectOpenCodeLauncher({
  disabled,
  onLaunch,
}: {
  disabled: boolean;
  onLaunch(leaf: Partial<LeafBase>): void;
}) {
  const projectId = useAuthStore((state) => state.projectId);
  const [open, setOpen] = useState(false);
  const [cwd, setCwd] = useState('');
  const [label, setLabel] = useState('OpenCode');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const launch = async () => {
    const attempt = ++generation.current;
    setBusy(true);
    setError('');
    try {
      if (
        !projectId ||
        !/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(cwd.trim()) ||
        /[\u0000-\u001f]/u.test(cwd)
      )
        throw Error('Choose an absolute project folder.');
      const detected = await invoke<NativeRuntimeDetection>('opencode_runtime_detect');
      if (
        !['systemCompatible', 'managedCompatible'].includes(detected.status) ||
        !detected.executablePath ||
        !/(?:^|[\\/])opencode(?:\.exe)?$/i.test(detected.executablePath)
      )
        throw Error('Connect a compatible OpenCode runtime in Settings first.');
      if (attempt !== generation.current || useAuthStore.getState().projectId !== projectId) return;
      onLaunch({
        command: detected.executablePath,
        cwd: cwd.trim(),
        name: label.trim() || 'OpenCode',
        projectId,
        preserveExisting: true,
      });
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'OpenCode could not be launched.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="relative">
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-1.5 text-[11px]"
        disabled={disabled || busy || !projectId}
        onClick={() => {
          setCwd(getStoredProjectRoot(projectId) ?? '');
          setOpen(!open);
        }}
      >
        Launch OpenCode
      </Button>
      {open && (
        <div
          role="group"
          aria-label="Launch OpenCode terminal"
          className="absolute right-0 top-full z-30 w-80 space-y-2 rounded border border-border bg-panel p-3 shadow-lg"
        >
          <label className="block text-sm">
            Folder
            <input
              aria-label="OpenCode terminal folder"
              className="w-full rounded border bg-background p-1"
              value={cwd}
              disabled={busy}
              onChange={(event) => setCwd(event.target.value)}
            />
          </label>
          <label className="block text-sm">
            Name
            <input
              aria-label="OpenCode terminal name"
              className="w-full rounded border bg-background p-1"
              value={label}
              maxLength={80}
              disabled={busy}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Starts the connected OpenCode executable directly. Its model and tool permissions come
            from OpenCode configuration.
          </p>
          <Button
            size="sm"
            disabled={disabled || busy || !cwd.trim()}
            onClick={() => void launch()}
          >
            Start OpenCode terminal
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              generation.current++;
              setOpen(false);
            }}
          >
            Cancel launch
          </Button>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
