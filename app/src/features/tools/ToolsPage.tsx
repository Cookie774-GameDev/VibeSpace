/**
 * Custom Tools page — author your own AI-callable actions.
 *
 * A "tool" is a saved preset of a built-in action: a friendly name + a
 * baseAction id (e.g. `terminal.run`) + the params you want frozen
 * (e.g. `{ command: 'npm run jarvis', cwd: 'C:\\proj' }`). Once saved, the
 * tool shows up in:
 *   - The actions palette (Mod+Shift+A) so you can fire it manually.
 *   - The Jarvis system-prompt addendum so the AI can propose it.
 *
 * Tool mutations are mirrored into VibeSpace Cloud account sync when signed in.
 * Public tool publishing remains separate from private account sync.
 */

import * as React from 'react';
import {
  Wrench,
  Plus,
  Pencil,
  Play,
  Trash2,
  Upload,
  Download,
  Cloud,
  Sparkles,
  Info,
  Workflow,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  useToolStore,
  type CustomTool,
  type CustomToolStep,
  slugify,
  parseToolStepsJson,
} from './toolStore';
import { getBuiltinActions, runAction } from '@/lib/actions';
import type { ActionDef, ActionParam } from '@/lib/actions';

/* --------------------------------------------------------------------------
 * Quick-start templates
 * --------------------------------------------------------------------------*/

interface QuickTemplate {
  emoji: string;
  name: string;
  description: string;
  baseAction: string;
  params: Record<string, unknown>;
  steps?: CustomToolStep[];
}

const QUICK_TEMPLATES: QuickTemplate[] = [
  {
    emoji: '🤖',
    name: 'Claude in my project',
    description: 'Open a terminal and start Claude Code in your main project.',
    baseAction: 'terminal.claude',
    params: { cwd: '' },
  },
  {
    emoji: '⚡',
    name: 'Run my dev server',
    description: 'Open a terminal and start your local dev server.',
    baseAction: 'terminal.run',
    params: { command: 'npm run jarvis', label: 'dev', cwd: '' },
  },
  {
    emoji: '🔑',
    name: 'Get a Gemini key',
    description: 'Open Google AI Studio in the browser to grab a free key.',
    baseAction: 'host.openUrl',
    params: { url: 'https://aistudio.google.com/apikey' },
  },
  {
    emoji: '🧪',
    name: 'Ship check',
    description: 'Open terminals and run a local verification command.',
    baseAction: 'workflow.run',
    params: {},
    steps: [
      { action: 'nav.terminal', params: {}, label: 'Open terminals' },
      {
        action: 'terminal.run',
        params: { command: 'npm --prefix app run typecheck', label: 'typecheck' },
        label: 'Run typecheck',
      },
    ],
  },
];

/* --------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------------*/

/** Built-in actions ordered for the base-action dropdown. */
function getEligibleBaseActions(): ActionDef[] {
  // Custom tools wrap built-ins only — wrapping another custom tool
  // would create a cycle. Filter out the `custom` category here.
  return getBuiltinActions().filter((a) => a.category !== 'custom');
}

/** Render the params object as a single readable line for tool cards. */
function summariseParams(params: Record<string, unknown>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null);
  if (entries.length === 0) return '— no params —';
  return entries
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ');
}

function summariseSteps(steps: CustomToolStep[] | undefined): string {
  if (!steps?.length) return '';
  return steps.map((step, index) => `${index + 1}. ${step.label ?? step.action}`).join(' -> ');
}

/** Coerce a form input value to the param's type before saving. */
function coerceParam(raw: string, p: ActionParam): unknown {
  if (raw === '') return p.default ?? '';
  if (p.type === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (p.type === 'boolean') {
    return raw === 'true' || raw === 'on';
  }
  return raw;
}

function defaultWorkflowJson(): string {
  return JSON.stringify(
    [
      { action: 'nav.terminal', params: {}, label: 'Open terminals' },
      {
        action: 'terminal.run',
        params: { command: 'npm --prefix app run typecheck', label: 'typecheck' },
        label: 'Run typecheck',
      },
    ],
    null,
    2,
  );
}

/* --------------------------------------------------------------------------
 * Editor dialog
 * --------------------------------------------------------------------------*/

interface ToolEditorProps {
  open: boolean;
  onClose: () => void;
  /** Existing tool when editing; null when creating new. */
  initial: CustomTool | null;
  /** Optional template to pre-fill (used by quick-start cards). */
  templateSeed?: QuickTemplate | null;
}

function ToolEditor({ open, onClose, initial, templateSeed }: ToolEditorProps) {
  const create = useToolStore((s) => s.create);
  const update = useToolStore((s) => s.update);
  const remove = useToolStore((s) => s.remove);

  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [emoji, setEmoji] = React.useState('');
  const [baseActionId, setBaseActionId] = React.useState('terminal.run');
  const [paramValues, setParamValues] = React.useState<Record<string, string>>({});
  const [workflowMode, setWorkflowMode] = React.useState(false);
  const [stepsJson, setStepsJson] = React.useState('');

  const eligible = React.useMemo(() => getEligibleBaseActions(), []);
  const baseAction = React.useMemo(
    () => eligible.find((a) => a.id === baseActionId),
    [eligible, baseActionId],
  );

  // Seed form when opened. Keep this idempotent — opening on the same
  // tool twice should not append, and template seeding shouldn't bleed
  // across opens.
  React.useEffect(() => {
    if (!open) return;
    if (initial) {
      setName(initial.name);
      setDescription(initial.description);
      setEmoji(initial.emoji ?? '');
      setBaseActionId(initial.baseAction);
      const initialSteps = initial.steps ?? [];
      setWorkflowMode(initialSteps.length > 0 || initial.baseAction === 'workflow.run');
      setStepsJson(initialSteps.length > 0 ? JSON.stringify(initialSteps, null, 2) : defaultWorkflowJson());
      const stringified: Record<string, string> = {};
      for (const [k, v] of Object.entries(initial.params)) {
        stringified[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
      setParamValues(stringified);
      return;
    }
    if (templateSeed) {
      setName(templateSeed.name);
      setDescription(templateSeed.description);
      setEmoji(templateSeed.emoji);
      setBaseActionId(templateSeed.baseAction);
      const seedSteps = templateSeed.steps ?? [];
      setWorkflowMode(seedSteps.length > 0 || templateSeed.baseAction === 'workflow.run');
      setStepsJson(seedSteps.length > 0 ? JSON.stringify(seedSteps, null, 2) : defaultWorkflowJson());
      const stringified: Record<string, string> = {};
      for (const [k, v] of Object.entries(templateSeed.params)) {
        stringified[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
      setParamValues(stringified);
      return;
    }
    // New tool, no template
    setName('');
    setDescription('');
    setEmoji('');
    setBaseActionId('terminal.run');
    setParamValues({});
    setWorkflowMode(false);
    setStepsJson(defaultWorkflowJson());
  }, [open, initial, templateSeed]);

  const handleSave = () => {
    if (!name.trim()) {
      toast.error('Name required', 'Give your tool a friendly name.');
      return;
    }
    let steps: CustomToolStep[] | undefined;
    if (workflowMode) {
      try {
        steps = parseToolStepsJson(stepsJson);
      } catch (err) {
        toast.error('Workflow JSON invalid', err instanceof Error ? err.message : String(err));
        return;
      }
    } else if (!baseAction) {
      toast.error('Base action missing', `Unknown action id: ${baseActionId}`);
      return;
    }

    const params: Record<string, unknown> = {};
    if (!workflowMode && baseAction) {
      // Build the params object using the spec to coerce types.
      for (const p of baseAction.params) {
        const raw = paramValues[p.key] ?? '';
        const coerced = coerceParam(raw, p);
        // Skip empty optional params so the runner uses its own defaults.
        if (!p.required && (coerced === '' || coerced === undefined || coerced === null)) {
          continue;
        }
        params[p.key] = coerced;
      }
    }
    const savedBaseAction = workflowMode ? 'workflow.run' : baseActionId;
    if (initial) {
      update(initial.slug, {
        name: name.trim(),
        description: description.trim(),
        emoji: emoji.trim() || undefined,
        baseAction: savedBaseAction,
        params,
        steps,
      });
      toast.success('Tool updated', name.trim());
    } else {
      const tool = create({
        name: name.trim(),
        description: description.trim(),
        emoji: emoji.trim() || undefined,
        baseAction: savedBaseAction,
        params,
        steps,
      });
      toast.success('Tool created', `Saved as custom.${tool.slug}`);
    }
    onClose();
  };

  const handleDelete = () => {
    if (!initial) return;
    if (!confirm(`Delete "${initial.name}"? This removes the local copy and queues a cloud-sync tombstone.`)) return;
    remove(initial.slug);
    toast.success('Tool deleted', initial.name);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-accent-copper" />
            {initial ? `Edit: ${initial.name}` : 'New custom tool'}
          </DialogTitle>
          <DialogDescription>
            Wrap one built-in action or chain several into a workflow. Once
            saved, Jarvis can propose it and you can fire it from the actions
            palette (Mod+Shift+A).
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-[80px_1fr] gap-2">
            <div>
              <Label htmlFor="tool-emoji" className="text-metadata uppercase tracking-wide">
                Emoji
              </Label>
              <Input
                id="tool-emoji"
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
                placeholder="🛠"
                maxLength={4}
                className="text-center"
              />
            </div>
            <div>
              <Label htmlFor="tool-name" className="text-metadata uppercase tracking-wide">
                Name
              </Label>
              <Input
                id="tool-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Run my dev server"
              />
              {name && (
                <div className="mt-1 text-metadata text-muted-foreground font-mono">
                  custom.{slugify(name) || 'tool'}
                </div>
              )}
            </div>
          </div>

          <div>
            <Label htmlFor="tool-desc" className="text-metadata uppercase tracking-wide">
              Description
            </Label>
            <Textarea
              id="tool-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Open a terminal in my project and start the dev server."
              rows={2}
            />
            <p className="mt-1 text-metadata text-muted-foreground">
              The AI sees this when deciding whether to propose your tool.
              Keep it short, specific, and unambiguous.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-panel p-1">
            <button
              type="button"
              onClick={() => setWorkflowMode(false)}
              className={cn(
                'rounded px-3 py-2 text-left text-secondary transition-colors',
                !workflowMode ? 'bg-elevated text-foreground shadow-soft' : 'text-muted-foreground hover:text-foreground',
              )}
              aria-pressed={!workflowMode}
            >
              <Wrench className="mr-1.5 inline h-3.5 w-3.5" />
              Single action
            </button>
            <button
              type="button"
              onClick={() => setWorkflowMode(true)}
              className={cn(
                'rounded px-3 py-2 text-left text-secondary transition-colors',
                workflowMode ? 'bg-elevated text-foreground shadow-soft' : 'text-muted-foreground hover:text-foreground',
              )}
              aria-pressed={workflowMode}
            >
              <Workflow className="mr-1.5 inline h-3.5 w-3.5" />
              Workflow
            </button>
          </div>

          <Separator />

          {workflowMode ? (
            <div>
              <Label htmlFor="tool-steps" className="text-metadata uppercase tracking-wide">
                Workflow steps JSON
              </Label>
              <Textarea
                id="tool-steps"
                value={stepsJson}
                onChange={(event) => setStepsJson(event.target.value)}
                rows={10}
                spellCheck={false}
                className="font-mono text-xs"
              />
              <p className="mt-1 text-metadata text-muted-foreground">
                Use a JSON array of built-in action steps. Custom actions are blocked here to prevent cycles.
              </p>
            </div>
          ) : (
          <>
            <div>
            <Label htmlFor="tool-base" className="text-metadata uppercase tracking-wide">
              Base action
            </Label>
            <select
              id="tool-base"
              value={baseActionId}
              onChange={(e) => setBaseActionId(e.target.value)}
              className={cn(
                'h-8 w-full rounded-md border border-border bg-input px-2',
                'text-secondary text-foreground',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              )}
            >
              {eligible.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} — {a.id}
                </option>
              ))}
            </select>
            {baseAction && (
              <p className="mt-1 text-metadata text-muted-foreground">
                {baseAction.description}
              </p>
            )}
            </div>

            {baseAction && baseAction.params.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-metadata uppercase tracking-wide text-muted-foreground">
                Preset parameters
              </div>
              {baseAction.params.map((p) => (
                <div key={p.key}>
                  <Label
                    htmlFor={`tool-param-${p.key}`}
                    className="flex items-center gap-1 text-metadata"
                  >
                    <span className="font-mono text-foreground/90">{p.key}</span>
                    <span className="text-muted-foreground">— {p.label}</span>
                    {p.required && <span className="text-destructive">*</span>}
                  </Label>
                  <Input
                    id={`tool-param-${p.key}`}
                    type={p.type === 'number' ? 'number' : 'text'}
                    value={paramValues[p.key] ?? ''}
                    onChange={(e) =>
                      setParamValues((s) => ({ ...s, [p.key]: e.target.value }))
                    }
                    placeholder={p.placeholder}
                  />
                  {p.help && (
                    <p className="mt-1 text-metadata text-muted-foreground">{p.help}</p>
                  )}
                </div>
              ))}
            </div>
            )}
          </>
          )}
        </div>

        <DialogFooter className="!justify-between">
          <div>
            {initial && (
              <Button variant="ghost" size="sm" onClick={handleDelete} className="text-destructive">
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="default" size="sm" onClick={handleSave}>
              {initial ? 'Save changes' : 'Create tool'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------------------------------------------------
 * Tool card
 * --------------------------------------------------------------------------*/

interface ToolCardProps {
  tool: CustomTool;
  onEdit: () => void;
  onRun: () => void;
}

function ToolCard({ tool, onEdit, onRun }: ToolCardProps) {
  const stepSummary = summariseSteps(tool.steps);
  return (
    <div className="rounded-lg border border-border bg-paper px-4 py-3 shadow-soft flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <span aria-hidden className="text-2xl leading-none mt-0.5">
          {tool.emoji || '🛠'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-body font-semibold text-foreground truncate">
            {tool.name}
          </div>
          <div className="text-metadata text-muted-foreground font-mono">
            custom.{tool.slug}
          </div>
        </div>
        <span
          className="text-metadata uppercase tracking-wide text-muted-foreground/70"
          title="Queued for VibeSpace Cloud account sync when signed in"
        >
          <Cloud className="mr-1 inline h-3 w-3" />
          sync
        </span>
      </div>

      {tool.description && (
        <p className="text-secondary text-muted-foreground leading-relaxed">
          {tool.description}
        </p>
      )}

      <div className="text-metadata text-muted-foreground/80">
        <span className="font-mono text-foreground/80">{tool.baseAction}</span>
        <span className="mx-1.5 opacity-60">·</span>
        <span className="font-mono">{stepSummary || summariseParams(tool.params)}</span>
      </div>

      <div className="mt-1 flex items-center gap-1.5">
        <Button size="sm" variant="default" onClick={onRun}>
          <Play className="h-3.5 w-3.5" /> Run
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" /> Edit
        </Button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Page
 * --------------------------------------------------------------------------*/

export function ToolsPage() {
  const tools = useToolStore((s) => s.tools);
  const importMany = useToolStore((s) => s.importMany);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const sorted = React.useMemo(
    () => [...tools].sort((a, b) => b.updatedAt - a.updatedAt),
    [tools],
  );

  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CustomTool | null>(null);
  const [templateSeed, setTemplateSeed] = React.useState<QuickTemplate | null>(null);

  const openNew = (seed: QuickTemplate | null = null) => {
    setEditing(null);
    setTemplateSeed(seed);
    setEditorOpen(true);
  };

  const openEdit = (tool: CustomTool) => {
    setEditing(tool);
    setTemplateSeed(null);
    setEditorOpen(true);
  };

  const runTool = async (tool: CustomTool) => {
    const res = await runAction(`custom.${tool.slug}`, {}, { source: 'user' });
    if (!res.ok) {
      toast.error('Tool failed', res.error);
    }
  };

  const handleExport = () => {
    const json = JSON.stringify(tools, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jarvis-custom-tools-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('Tools exported', `${tools.length} tool${tools.length === 1 ? '' : 's'}.`);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        toast.error('Import failed', 'File must contain a JSON array of tools.');
        return;
      }
      const count = importMany(parsed);
      if (count === 0) {
        toast.warning('Nothing imported', 'No valid tools found in that file.');
      } else {
        toast.success('Tools imported', `Added ${count} tool${count === 1 ? '' : 's'}.`);
      }
    } catch (err) {
      toast.error('Import failed', err instanceof Error ? err.message : String(err));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-paper-warm">
      <div className="mx-auto w-full max-w-5xl p-8">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
          <div>
            <p className="text-metadata uppercase tracking-wider text-accent-copper">
              <Sparkles className="mr-1 inline h-3 w-3" />
              Custom tools
            </p>
            <h1 className="font-display text-hero text-foreground mt-1">
              Author your own actions
            </h1>
            <p className="mt-2 max-w-2xl text-secondary text-muted-foreground leading-relaxed">
              Wrap any built-in action with preset params, or chain several
              actions into a workflow. Save it once; Jarvis can propose it
              from chat, and you can fire it from the actions palette
              (Mod+Shift+A) or run it from this page.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json"
              onChange={handleImport}
              className="hidden"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              title="Import tools from JSON"
            >
              <Upload className="h-3.5 w-3.5" /> Import
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleExport}
              disabled={tools.length === 0}
              title="Export all tools as JSON"
            >
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
            <Button variant="default" size="sm" onClick={() => openNew(null)}>
              <Plus className="h-3.5 w-3.5" /> New tool
            </Button>
          </div>
        </div>

        {/* Cloud sync banner */}
        <div className="rounded-md border border-border bg-elevated px-3 py-2 mb-6 flex items-start gap-2">
          <Cloud className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-secondary text-muted-foreground leading-relaxed">
            <span className="text-foreground font-medium">VibeSpace Cloud sync</span>{' '}
            now queues private custom-tool changes for your account when signed in.
            Export / Import still works for manual backups and offline moves.
          </div>
        </div>

        {/* Quick-start templates (always visible — they make new tools cheap) */}
        <div className="mb-8">
          <h2 className="text-secondary text-foreground font-medium mb-2">
            Quick start
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {QUICK_TEMPLATES.map((t) => (
              <button
                key={t.name}
                onClick={() => openNew(t)}
                className={cn(
                  'rounded-md border border-border bg-paper px-3 py-2 text-left',
                  'hover:border-accent-copper/50 hover:bg-paper-warm',
                  'transition-colors flex flex-col gap-1',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="text-lg leading-none">{t.emoji}</span>
                  <span className="text-secondary text-foreground font-medium">
                    {t.name}
                  </span>
                </div>
                <p className="text-metadata text-muted-foreground leading-snug">
                  {t.description}
                </p>
              </button>
            ))}
          </div>
        </div>

        {/* Tool list (or empty state) */}
        <div>
          <h2 className="text-secondary text-foreground font-medium mb-2 flex items-center gap-2">
            Your tools
            <span className="text-metadata text-muted-foreground font-normal">
              {sorted.length} saved
            </span>
          </h2>
          {sorted.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
              <Wrench className="h-6 w-6 text-muted-foreground/60 mx-auto mb-2" />
              <p className="text-secondary text-muted-foreground">
                No tools yet. Pick a quick-start above, or click{' '}
                <span className="text-foreground">New tool</span> to start
                from scratch.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {sorted.map((t) => (
                <ToolCard
                  key={t.slug}
                  tool={t}
                  onEdit={() => openEdit(t)}
                  onRun={() => runTool(t)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="mt-10 flex items-start gap-2 text-metadata text-muted-foreground/80">
          <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <p>
            Tools are stored locally under <span className="font-mono">jarvis-tools</span>{' '}
            and mirrored into the local sync queue for signed-in VibeSpace Cloud accounts.
          </p>
        </div>
      </div>

      <ToolEditor
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        initial={editing}
        templateSeed={templateSeed}
      />
    </div>
  );
}
