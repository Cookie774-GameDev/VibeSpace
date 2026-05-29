/**
 * AgentManager - the settings-section UI for viewing, editing, cloning, and
 * deleting agents.
 *
 * Layout: a list of agents on the left, a detail editor on the right.
 * The editor is a controlled form bound to a draft state object that's reset
 * whenever the selection changes. "Save" pushes the diff into the agent store;
 * "Clone" creates a new non-builtin copy with a fresh id; "Delete" removes a
 * non-builtin agent entirely (built-ins cannot be deleted, only edited).
 *
 * Persistence: this component reads from and writes to `useAgentStore`. The
 * store is the in-memory roster the rest of the app binds to. A sibling
 * subagent owns the database side of seeding/persistence; this component does
 * not interact with the DB directly.
 */
import * as React from 'react';
import { Trash2, Copy, Save, RotateCcw, Sparkles, Lock } from 'lucide-react';
import type { Agent, AgentId, ProviderId } from '@/types';
import { useAgentStore } from '@/stores/agents';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { newAgentId } from '@/lib/ids';
import { AgentBadge } from './AgentBadge';
import { getDefaultAgents } from './registry';

const PROVIDERS: ProviderId[] = [
  'mock',
  'anthropic',
  'openai',
  'google',
  'xai',
  'openrouter',
  'groq',
  'deepseek',
  'mistral',
  'together',
  'ollama',
  'local',
];

/** Tracks the editable subset of an agent. */
interface DraftState {
  name: string;
  description: string;
  system_prompt: string;
  provider: ProviderId;
  model: string;
  temperature: number;
}

function agentToDraft(a: Agent): DraftState {
  return {
    name: a.name,
    description: a.description,
    system_prompt: a.system_prompt,
    provider: a.model.provider,
    model: a.model.model,
    temperature: a.temperature ?? 0.7,
  };
}

function draftDiffers(d: DraftState, a: Agent): boolean {
  return (
    d.name !== a.name ||
    d.description !== a.description ||
    d.system_prompt !== a.system_prompt ||
    d.provider !== a.model.provider ||
    d.model !== a.model.model ||
    d.temperature !== (a.temperature ?? 0.7)
  );
}

export function AgentManager() {
  const agents = useAgentStore((s) => s.agents);
  const registerMany = useAgentStore((s) => s.registerMany);
  const registerAgent = useAgentStore((s) => s.registerAgent);
  const unregisterAgent = useAgentStore((s) => s.unregisterAgent);
  const updateAgent = useAgentStore((s) => s.updateAgent);

  const agentList = React.useMemo(() => {
    const arr = Object.values(agents);
    // Built-ins first, then alphabetical within each group.
    return arr.sort((a, b) => {
      const bi = (b.builtin ? 1 : 0) - (a.builtin ? 1 : 0);
      if (bi !== 0) return bi;
      return a.name.localeCompare(b.name);
    });
  }, [agents]);

  const [selectedId, setSelectedId] = React.useState<AgentId | null>(null);

  // Auto-select the first agent when the list materialises or the current one
  // is removed.
  React.useEffect(() => {
    if (selectedId && agents[selectedId]) return;
    setSelectedId(agentList[0]?.id ?? null);
  }, [agentList, agents, selectedId]);

  const selectedAgent: Agent | null = selectedId ? agents[selectedId] ?? null : null;

  // Draft is reset whenever the *selection* changes (not when the agent
  // reference updates after a save).
  const [draft, setDraft] = React.useState<DraftState | null>(null);
  React.useEffect(() => {
    setDraft(selectedAgent ? agentToDraft(selectedAgent) : null);
    // Intentionally watch selectedAgent?.id, not the whole agent reference.
  }, [selectedAgent?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !!(draft && selectedAgent && draftDiffers(draft, selectedAgent));

  const handleSave = () => {
    if (!selectedAgent || !draft || !dirty) return;
    updateAgent(selectedAgent.id, {
      name: draft.name,
      description: draft.description,
      system_prompt: draft.system_prompt,
      model: { ...selectedAgent.model, provider: draft.provider, model: draft.model },
      temperature: draft.temperature,
    });
    toast.success('Saved', `Updated "${draft.name}"`);
  };

  const handleReset = () => {
    if (!selectedAgent) return;
    setDraft(agentToDraft(selectedAgent));
  };

  const handleClone = () => {
    if (!selectedAgent || !draft) return;
    const id = newAgentId();
    const t = Date.now();
    const cloned: Agent = {
      ...selectedAgent,
      id,
      // Suffix the slug so it stays unique without collision logic.
      slug: `${selectedAgent.slug}_copy_${id.slice(-4)}`,
      name: draft.name + ' (copy)',
      description: draft.description,
      system_prompt: draft.system_prompt,
      model: { ...selectedAgent.model, provider: draft.provider, model: draft.model },
      temperature: draft.temperature,
      builtin: false,
      created_at: t,
      updated_at: t,
    };
    registerAgent(cloned);
    setSelectedId(id);
    toast.success('Cloned', `Created "${cloned.name}"`);
  };

  const handleDelete = () => {
    if (!selectedAgent || selectedAgent.builtin) return;
    const name = selectedAgent.name;
    unregisterAgent(selectedAgent.id);
    toast.info('Deleted', `Removed "${name}"`);
  };

  const seedDefaults = () => {
    registerMany(getDefaultAgents());
    toast.success('Loaded', '7 default agents added');
  };

  return (
    <div className="flex h-full min-h-[520px] surface-panel rounded-lg overflow-hidden">
      {/* List pane */}
      <div className="w-64 border-r border-border flex flex-col bg-elevated">
        <div className="px-3 py-2.5 flex items-center justify-between">
          <div className="text-ui-strong text-foreground">Agents</div>
          <Badge variant="outline">{agentList.length}</Badge>
        </div>
        <Separator />
        <div className="flex-1 overflow-y-auto py-1 scrollbar-hidden">
          {agentList.length === 0 ? (
            <div className="p-4 text-center">
              <div className="text-secondary text-muted-foreground mb-3">
                No agents loaded yet.
              </div>
              <Button variant="accent" size="sm" onClick={seedDefaults}>
                <Sparkles className="h-3.5 w-3.5" />
                Seed defaults
              </Button>
            </div>
          ) : (
            agentList.map((agent) => {
              const active = selectedId === agent.id;
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => setSelectedId(agent.id)}
                  className={cn(
                    'w-full text-left px-3 py-2 transition-colors flex items-center gap-2',
                    active ? 'bg-muted text-foreground' : 'hover:bg-muted/50',
                  )}
                >
                  <AgentBadge agent={agent} showName={false} size="sm" />
                  <div className="flex-1 min-w-0">
                    <div className="text-secondary font-medium text-foreground truncate">
                      {agent.name}
                    </div>
                    <div className="text-metadata text-muted-foreground truncate">
                      {agent.description}
                    </div>
                  </div>
                  {agent.builtin && (
                    <Lock
                      className="h-3 w-3 text-muted-foreground shrink-0"
                      aria-label="Built-in agent"
                    />
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Detail pane */}
      <div className="flex-1 overflow-y-auto">
        {selectedAgent && draft ? (
          <div className="p-5 space-y-5 max-w-3xl">
            {/* Header with actions */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <AgentBadge agent={selectedAgent} showName={false} size="lg" />
                <div className="min-w-0">
                  <div className="text-page-title text-foreground truncate">
                    {selectedAgent.name}
                  </div>
                  <div className="text-metadata text-muted-foreground font-mono truncate">
                    {selectedAgent.slug}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button variant="ghost" size="sm" onClick={handleReset} disabled={!dirty}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reset
                </Button>
                <Button variant="ghost" size="sm" onClick={handleClone}>
                  <Copy className="h-3.5 w-3.5" />
                  Clone
                </Button>
                {!selectedAgent.builtin && (
                  <Button variant="ghost" size="sm" onClick={handleDelete}>
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </Button>
                )}
                <Button variant="accent" size="sm" onClick={handleSave} disabled={!dirty}>
                  <Save className="h-3.5 w-3.5" />
                  Save
                </Button>
              </div>
            </div>

            <Separator />

            {/* Editable fields */}
            <div className="space-y-4">
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="agent-name">Name</Label>
                  <Input
                    id="agent-name"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="agent-desc">Description</Label>
                  <Input
                    id="agent-desc"
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="agent-provider">Provider</Label>
                  <select
                    id="agent-provider"
                    value={draft.provider}
                    onChange={(e) =>
                      setDraft({ ...draft, provider: e.target.value as ProviderId })
                    }
                    className={cn(
                      'flex h-8 w-full rounded-md border border-input bg-background px-2 text-body text-foreground',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      'transition-colors',
                    )}
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="agent-model">Model</Label>
                  <Input
                    id="agent-model"
                    value={draft.model}
                    onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                    placeholder="e.g. claude-3-5-sonnet-20241022 / mock-default"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="agent-temp">
                  Temperature
                  <span className="ml-2 font-mono text-metadata text-muted-foreground">
                    {draft.temperature.toFixed(2)}
                  </span>
                </Label>
                <input
                  id="agent-temp"
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={draft.temperature}
                  onChange={(e) =>
                    setDraft({ ...draft, temperature: Number(e.target.value) })
                  }
                  className="w-full"
                  style={{ accentColor: 'hsl(var(--accent-cyan))' }}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="agent-prompt">System prompt</Label>
                <Textarea
                  id="agent-prompt"
                  value={draft.system_prompt}
                  onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })}
                  className="min-h-[260px] font-mono text-secondary leading-relaxed"
                />
                <div className="text-metadata text-muted-foreground">
                  {draft.system_prompt.length.toLocaleString()} chars · ~
                  {Math.ceil(draft.system_prompt.length / 4).toLocaleString()} tokens
                </div>
              </div>

              <Separator />

              {/* Read-only metadata */}
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
                <div>
                  <Label className="block mb-1.5">Capabilities</Label>
                  <div className="flex flex-wrap gap-1">
                    {selectedAgent.capabilities.length === 0 ? (
                      <span className="text-metadata text-muted-foreground">none</span>
                    ) : (
                      selectedAgent.capabilities.map((c) => (
                        <Badge key={c} variant="secondary" className="text-metadata">
                          {c}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>
                <div>
                  <Label className="block mb-1.5">Memory scope</Label>
                  <Badge variant="outline">{selectedAgent.memory_scope}</Badge>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-10 text-center text-secondary text-muted-foreground">
            Select an agent to inspect.
          </div>
        )}
      </div>
    </div>
  );
}
