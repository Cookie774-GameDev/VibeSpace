import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ExternalLink,
  BookOpen,
  Shield,
  ScrollText,
  RefreshCw,
  Download,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { isTauri } from '@/lib/utils';
import {
  checkForAppUpdate,
  getAutoUpdateEnabled,
  setAutoUpdateEnabled as persistAutoUpdateEnabled,
  type UpdatePhase,
  type UpdateResult,
} from '@/lib/updates';

const VERSION = import.meta.env.VITE_APP_VERSION || '0.1.0';

const LINKS: { label: string; href: string; icon: typeof BookOpen }[] = [
  {
    label: 'Documentation',
    href: 'https://github.com/Cookie774-GameDev/VibeSpace#readme',
    icon: BookOpen,
  },
  {
    label: 'Downloads',
    href: 'https://github.com/Cookie774-GameDev/VibeSpace/blob/main/DOWNLOAD.md',
    icon: Shield,
  },
  {
    label: 'License',
    href: 'https://github.com/Cookie774-GameDev/VibeSpace/blob/main/LICENSE',
    icon: ScrollText,
  },
];

export function About() {
  const telemetryOptIn = useAuthStore((s) => s.telemetryOptIn);
  const setTelemetryOptIn = useAuthStore((s) => s.setTelemetryOptIn);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>('idle');
  const [pendingUpdate, setPendingUpdate] = useState<UpdateResult | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | undefined>();

  useEffect(() => {
    setAutoUpdate(getAutoUpdateEnabled());
  }, []);

  const setAutoUpdateEnabled = (v: boolean) => {
    setAutoUpdate(v);
    persistAutoUpdateEnabled(v);
  };

  const checkForUpdates = async () => {
    setUpdatePhase('checking');
    setUpdateError(null);
    setPendingUpdate(null);
    try {
      const result = await checkForAppUpdate();
      if (result.available) {
        setPendingUpdate(result);
        setUpdatePhase('available');
        toast.info('Update available', `Jarvis ${result.version} is ready to install.`);
      } else {
        setUpdatePhase('none');
        toast.success('Jarvis is up to date');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not check for updates.';
      setUpdatePhase('error');
      setUpdateError(message);
      toast.error('Update check failed', message);
    }
  };

  const installUpdate = async () => {
    setUpdatePhase('downloading');
    setUpdateError(null);
    setDownloadedBytes(0);
    setTotalBytes(undefined);
    try {
      const result = await checkForAppUpdate({
        install: true,
        onProgress: (progress) => {
          setUpdatePhase(progress.phase);
          setDownloadedBytes(progress.downloadedBytes ?? 0);
          setTotalBytes(progress.totalBytes);
        },
      });
      if (!result.available) {
        setPendingUpdate(null);
        setUpdatePhase('none');
        toast.success('Jarvis is up to date');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not install the update.';
      setUpdatePhase('error');
      setUpdateError(message);
      toast.error('Update install failed', message);
    }
  };

  const busy =
    updatePhase === 'checking' || updatePhase === 'downloading' || updatePhase === 'installing';

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-page-title text-foreground">About</h2>
        <p className="text-secondary text-muted-foreground mt-1">
          VibeSpace - your local-first council of agents.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-4 max-w-md">
        <KV label="Version" value={VERSION} />
        <KV label="License" value="Apache-2.0" />
        <KV label="Build" value={isTauri ? 'Tauri desktop' : 'Web preview'} />
        <KV label="Channel" value={import.meta.env.DEV ? 'dev' : 'stable'} />
      </section>

      <section className="max-w-xl rounded-2xl border border-border bg-elevated/70 p-5 shadow-soft">
        <h3 className="text-ui-strong text-foreground mb-4">Version History & Roadmap</h3>
        <div className="flex flex-col gap-5 border-l border-border pl-4 relative">
          <div className="relative">
            <div className="absolute -left-[21.5px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-accent-copper bg-panel" />
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-foreground text-secondary">v0.1.20 (Latest)</span>
              <span className="text-metadata text-muted-foreground font-mono">June 6, 2026</span>
            </div>
            <p className="text-secondary text-muted-foreground mt-1 leading-relaxed">
              Secure Plugins in Settings with a 353-service catalog, OS-keychain credentials, tested
              GitHub/Figma/Supabase/Shopify/Slack connectors, metadata-only cloud sync, and
              controlled terminal capability context.
            </p>
          </div>

          <div className="relative">
            <div className="absolute -left-[21.5px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-border/80 bg-panel" />
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-foreground text-secondary">v0.1.14</span>
              <span className="text-metadata text-muted-foreground font-mono">June 2, 2026</span>
            </div>
            <p className="text-secondary text-muted-foreground mt-1 leading-relaxed">
              Context maps, file routing, done-notification controls, slash commands, command-parser
              suggestions, STT optimization, and terminal project-switch stabilization.
            </p>
          </div>

          <div className="relative border-t border-border/50 pt-4 mt-1">
            <div className="flex items-center gap-1 text-accent-cyan text-metadata uppercase tracking-wider font-semibold">
              <span>What to Expect Next</span>
            </div>
            <p className="text-secondary text-muted-foreground mt-1 leading-relaxed">
              OAuth browser flows, additional tested MCP servers, and final cross-platform installer
              verification.
            </p>
          </div>
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-2">
        <h3 className="text-ui-strong text-foreground">Resources</h3>
        <ul className="flex flex-col">
          {LINKS.map((l) => {
            const Icon = l.icon;
            return (
              <li key={l.label}>
                <a
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-center justify-between gap-2 px-1.5 py-1.5 rounded-md text-secondary text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  <span className="flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5" />
                    {l.label}
                  </span>
                  <ExternalLink className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                </a>
              </li>
            );
          })}
        </ul>
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3 max-w-md">
          <div className="flex flex-col gap-1">
            <Label htmlFor="telemetry-toggle">Anonymous usage telemetry</Label>
            <p className="text-metadata text-muted-foreground">
              Helps us prioritize. No prompts, no message contents, ever. You can revoke at any
              time.
            </p>
          </div>
          <Switch
            id="telemetry-toggle"
            checked={telemetryOptIn}
            onCheckedChange={setTelemetryOptIn}
          />
        </div>

        <div className="flex items-start justify-between gap-3 max-w-md">
          <div className="flex flex-col gap-1">
            <Label htmlFor="auto-update-toggle">Auto-install updates</Label>
            <p className="text-metadata text-muted-foreground">
              {isTauri
                ? 'Jarvis checks on launch and installs signed updates automatically after warning at 1 hour, 30 minutes, and 5 minutes. Use Update Later to defer.'
                : 'Install the desktop app to receive signed updates.'}
            </p>
          </div>
          <Switch
            id="auto-update-toggle"
            checked={autoUpdate}
            onCheckedChange={setAutoUpdateEnabled}
            disabled={!isTauri}
          />
        </div>
      </section>

      <Separator />

      <section className="max-w-xl rounded-2xl border border-border bg-elevated/70 p-4 shadow-soft">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="text-ui-strong text-foreground">Updates</h3>
            <p className="text-secondary text-muted-foreground">
              Signed releases are delivered from GitHub Releases. Jarvis verifies every bundle,
              shows pre-install warnings, and lets you update now or later.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void checkForUpdates()}
            disabled={!isTauri || busy}
          >
            <RefreshCw
              className={updatePhase === 'checking' ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'}
            />
            Check now
          </Button>
        </div>

        <div className="mt-4 rounded-xl border border-border/70 bg-background/55 px-3 py-3">
          <UpdateStatus
            phase={updatePhase}
            pendingUpdate={pendingUpdate}
            error={updateError}
            downloadedBytes={downloadedBytes}
            totalBytes={totalBytes}
          />
          {updatePhase === 'available' && pendingUpdate ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" onClick={() => void installUpdate()} disabled={busy}>
                <Download className="h-3.5 w-3.5" /> Download & install
              </Button>
              <span className="text-metadata text-muted-foreground">
                Jarvis will relaunch after installation.
              </span>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function UpdateStatus({
  phase,
  pendingUpdate,
  error,
  downloadedBytes,
  totalBytes,
}: {
  phase: UpdatePhase;
  pendingUpdate: UpdateResult | null;
  error: string | null;
  downloadedBytes: number;
  totalBytes?: number;
}) {
  if (!isTauri) {
    return (
      <StatusLine
        icon={<AlertTriangle className="h-4 w-4 text-accent-amber" />}
        title="Desktop app required"
        body="Updater checks are disabled in the browser preview."
      />
    );
  }

  if (phase === 'checking') {
    return (
      <StatusLine
        icon={<RefreshCw className="h-4 w-4 animate-spin text-accent-cyan" />}
        title="Checking for updates"
        body="Contacting the signed release channel."
      />
    );
  }

  if (phase === 'available' && pendingUpdate) {
    return (
      <StatusLine
        icon={<Download className="h-4 w-4 text-accent-cyan" />}
        title={`Jarvis ${pendingUpdate.version} is available`}
        body={pendingUpdate.notes || 'A new signed release is ready.'}
      />
    );
  }

  if (phase === 'downloading') {
    return (
      <StatusLine
        icon={<RefreshCw className="h-4 w-4 animate-spin text-accent-cyan" />}
        title="Downloading update"
        body={formatProgress(downloadedBytes, totalBytes)}
      />
    );
  }

  if (phase === 'installing') {
    return (
      <StatusLine
        icon={<RefreshCw className="h-4 w-4 animate-spin text-accent-cyan" />}
        title="Installing update"
        body="Jarvis will relaunch when installation finishes."
      />
    );
  }

  if (phase === 'installed') {
    return (
      <StatusLine
        icon={<CheckCircle2 className="h-4 w-4 text-success" />}
        title="Update installed"
        body="Relaunching Jarvis."
      />
    );
  }

  if (phase === 'none') {
    return (
      <StatusLine
        icon={<CheckCircle2 className="h-4 w-4 text-success" />}
        title="Jarvis is up to date"
        body="No newer signed release was found."
      />
    );
  }

  if (phase === 'error') {
    return (
      <StatusLine
        icon={<AlertTriangle className="h-4 w-4 text-destructive" />}
        title="Update check failed"
        body={error ?? 'Try again later.'}
      />
    );
  }

  return (
    <StatusLine
      icon={<CheckCircle2 className="h-4 w-4 text-muted-foreground" />}
      title="Ready"
      body="Use Check now to look for the latest signed release."
    />
  );
}

function StatusLine({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0">
        <div className="text-secondary font-semibold text-foreground">{title}</div>
        <p className="mt-0.5 text-metadata text-muted-foreground leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

function formatProgress(downloadedBytes: number, totalBytes: number | undefined): string {
  if (!totalBytes) return `${formatBytes(downloadedBytes)} downloaded.`;
  const pct = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
  return `${formatBytes(downloadedBytes)} of ${formatBytes(totalBytes)} downloaded (${pct}%).`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-metadata text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className="text-secondary text-foreground font-mono">{value}</span>
    </div>
  );
}
