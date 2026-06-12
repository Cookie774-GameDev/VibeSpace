import { useMemo } from 'react';
import { Bot, Check, Keyboard, Play, Wrench, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useUIStore } from '@/stores/ui';
import { BUILTIN_ACTION_COUNT, getAllActions } from '@/lib/actions';
import { useToolStore } from '@/features/tools/toolStore';
import { HOTKEYS } from '@/lib/hotkeys';

export function JarvisActions() {
  const setRoute = useUIStore((s) => s.setRoute);
  const setActionsPaletteOpen = useUIStore((s) => s.setActionsPaletteOpen);
  const customCount = useToolStore((s) => s.tools.length);
  const totalCount = useMemo(() => getAllActions().length, [customCount]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-page-title text-foreground">Jarvis Actions</h2>
        <p className="mt-1 max-w-2xl text-secondary text-muted-foreground">
          Jarvis can propose app commands in chat — open terminals, navigate pages, run dev
          scripts, and more. Nothing runs until you click <strong>Approve</strong> or{' '}
          <strong>Approve all</strong>. Works with any model (Ollama, Gemini, Claude, etc.)
          when you talk to Jarvis.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-metadata">
            {BUILTIN_ACTION_COUNT} built-in actions
          </Badge>
          <Badge variant="outline" className="text-metadata">
            {customCount} custom command{customCount === 1 ? '' : 's'}
          </Badge>
          <Badge variant="outline" className="text-metadata text-sage">
            {totalCount} available to Jarvis
          </Badge>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-border bg-panel p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-ui-strong text-foreground">
            <Zap className="h-4 w-4 text-accent-copper" />
            Actions palette
          </div>
          <p className="text-secondary text-muted-foreground text-sm">
            Browse and run any action yourself — same catalogue Jarvis sees in chat.
          </p>
          <Button
            variant="default"
            size="sm"
            className="w-fit"
            onClick={() => setActionsPaletteOpen(true)}
          >
            <Play className="h-3.5 w-3.5" />
            Open palette ({HOTKEYS.ACTIONS})
          </Button>
        </div>

        <div className="rounded-md border border-border bg-panel p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-ui-strong text-foreground">
            <Wrench className="h-4 w-4 text-accent-cyan" />
            Custom commands
          </div>
          <p className="text-secondary text-muted-foreground text-sm">
            Save your own one-click commands or multi-step workflows Jarvis can propose later.
          </p>
          <Button variant="outline" size="sm" className="w-fit" onClick={() => setRoute('tools')}>
            <Wrench className="h-3.5 w-3.5" />
            Manage custom tools
          </Button>
        </div>
      </section>

      <section className="rounded-md border border-border bg-elevated p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2 text-ui-strong text-foreground">
          <Bot className="h-4 w-4 text-accent-copper" />
          How approval works
        </div>
        <ul className="list-disc pl-5 text-secondary text-muted-foreground text-sm space-y-1.5">
          <li>Ask Jarvis in chat or voice — e.g. “Open 5 terminals with opencode”.</li>
          <li>Jarvis replies with an approval card showing what it wants to do.</li>
          <li>Click Approve, Approve all, or Cancel. Destructive actions are always gated.</li>
          <li>
            Jarvis can also save new commands with{' '}
            <code className="font-mono text-foreground/90">custom.createTerminalCommand</code> or{' '}
            <code className="font-mono text-foreground/90">custom.createWorkflowTool</code>.
          </li>
        </ul>
        <div className="flex items-center gap-2 text-metadata text-muted-foreground">
          <Keyboard className="h-3.5 w-3.5" />
          Palette: {HOTKEYS.ACTIONS} · Settings: {HOTKEYS.SETTINGS}
        </div>
        <div className="inline-flex items-center gap-1.5 text-metadata text-sage">
          <Check className="h-3.5 w-3.5" />
          Bulk terminal opens use <code className="font-mono">terminal.bulkOpen</code> or presets like{' '}
          <code className="font-mono">terminal.bulkOpen.5</code>.
        </div>
      </section>
    </div>
  );
}
