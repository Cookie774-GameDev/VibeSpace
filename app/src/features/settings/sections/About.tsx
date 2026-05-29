import { ExternalLink, BookOpen, Shield, ScrollText } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { isTauri } from '@/lib/utils';

const VERSION = import.meta.env.VITE_APP_VERSION || '0.1.0';

const LINKS: { label: string; href: string; icon: typeof BookOpen }[] = [
  { label: 'Documentation', href: 'https://github.com/jarvis-ai/jarvis#readme', icon: BookOpen },
  { label: 'Privacy', href: 'https://github.com/jarvis-ai/jarvis/blob/main/PRIVACY.md', icon: Shield },
  { label: 'License', href: 'https://github.com/jarvis-ai/jarvis/blob/main/LICENSE', icon: ScrollText },
];

export function About() {
  const telemetryOptIn = useAuthStore((s) => s.telemetryOptIn);
  const setTelemetryOptIn = useAuthStore((s) => s.setTelemetryOptIn);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-page-title text-foreground">About</h2>
        <p className="text-secondary text-muted-foreground mt-1">
          Jarvis - your local-first council of agents.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-4 max-w-md">
        <KV label="Version" value={VERSION} />
        <KV label="License" value="Apache-2.0" />
        <KV label="Build" value={isTauri ? 'Tauri desktop' : 'Web preview'} />
        <KV label="Channel" value={import.meta.env.DEV ? 'dev' : 'stable'} />
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
              Helps us prioritize. No prompts, no message contents, ever. You can revoke at any time.
            </p>
          </div>
          <Switch
            id="telemetry-toggle"
            checked={telemetryOptIn}
            onCheckedChange={setTelemetryOptIn}
          />
        </div>
      </section>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-metadata text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className="text-secondary text-foreground font-mono">{value}</span>
    </div>
  );
}
