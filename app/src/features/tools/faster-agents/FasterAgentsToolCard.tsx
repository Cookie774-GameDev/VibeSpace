import { Gauge, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUIStore } from '@/stores/ui';
import { useFasterAgentsStore } from '@/features/terminals/faster-agents/fasterAgentsStore';

export function FasterAgentsToolCard() {
  const run = () => {
    useFasterAgentsStore.getState().launch();
    const ui = useUIStore.getState();
    if (ui.route !== 'workbench') ui.setRoute('terminal');
  };
  return (
    <article className="flex min-h-36 items-center gap-4 rounded-lg border border-accent-copper/35 bg-gradient-to-br from-paper to-accent-copper/10 px-4 py-4 shadow-soft">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-accent-copper/35 bg-accent-copper/15">
        <Gauge className="h-5 w-5 text-accent-copper" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-foreground">Faster Agents</span>
        <span className="mt-0.5 block text-sm text-muted-foreground">
          Select up to 10 terminals, then whip in your own focused prompts.
        </span>
      </span>
      <Button type="button" size="sm" onClick={run} aria-label="Run Faster Agents">
        <Play className="h-3.5 w-3.5" /> Run
      </Button>
    </article>
  );
}
