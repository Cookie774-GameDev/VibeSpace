import { Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function CommandCenterToolCard() {
  return (
    <article
      data-monochrome-surface="preloaded-command-center"
      className="flex min-h-36 flex-col gap-3 rounded-lg border border-border bg-paper px-4 py-4 shadow-soft [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-accent-copper/25 bg-accent-copper/10">
          <Activity className="h-5 w-5 text-accent-copper" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-foreground">Codex Command Center</h3>
          <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
            Lightweight local control for terminals, schedules, progress, daily goals, and
            milestones.
          </p>
        </div>
        <span className="text-xs font-medium text-muted-foreground">Preloaded</span>
      </div>

      <div className="mt-auto">
        <Button size="sm" disabled title="Codex Command Center is coming soon.">
          Coming soon
        </Button>
      </div>
    </article>
  );
}
