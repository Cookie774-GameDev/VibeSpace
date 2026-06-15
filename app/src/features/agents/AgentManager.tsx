/**
 * AgentManager - the settings-section UI for viewing, editing, cloning, and
 * deleting agents.
 *
 * Layout: a list of agents on the left, a detail editor on the right.
 * whenever the selection changes. "Save" persists the diff to IndexedDB and
 * updates the runtime store; "Clone" creates a durable non-builtin copy with a
 * fresh id; "Delete" removes a non-builtin agent entirely.
 */
import * as React from 'react';
import { Trash2, Copy, Save, RotateCcw, Sparkles, Lock } from 'lucide-react';
import type { Agent, AgentId, ProviderId } from '@/types';
import { useAgentStore } from '@/stores/agents';
import { useAuthStore } from '@/stores/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { newAgentId } from '@/lib/ids';
import { agentRepo } from '@/lib/db';
import { AgentBadge } from './AgentBadge';
import { getDefaultAgents } from './registry';
import { getAgentRole, ROLE_PERSONAS, type AgentRole } from './personas';
import {
  agentEditorProviderFromAgent,
  agentModelFromEditorChoice,
  getAgentEditorProviderOptions,
  type AgentEditorProviderChoice,
} from '@/lib/ai/agentProviderOptions';
import { getAccessibleModelOptions, useOllamaModelOptions, syncDiscoveredOllamaModels } from '@/lib/ai/models';

/**
 * Tiny role-pill for swarm agents (Scout / Builder / Reviewer).
 *
 * Inline implementation to avoid a new dependency. Reuses the existing
 * `.sev-pill` typography/sizing (defined in globals.css) and only overrides
 * the gradient so each role's hue (sage / terracotta / lavender) matches the
 * persona table. The role text itself is the label - short, scannable.
 */
function RolePill({ role }: { role: AgentRole }) {
  const persona = ROLE_PERSONAS[role];
  const hue = persona.colorHue;
  return (
    <span
      className="sev-pill shrink-0"
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 45% 52%) 0%, hsl(${hue} 50% 38%) 100%)`,
      }}
      title={`${persona.name}: ${persona.oneLiner}`}
      aria-label={`${persona.name} role`}
    >
      {role}
    </span>
  );
}

/** Tracks the editable subset of an agent. */
interface DraftState {
  name: string;
  description: string;
  system_prompt: string;
  providerChoice: AgentEditorProviderChoice;
  provider: ProviderId;
  model: string;
  temperature: number;
}

function agentToDraft(a: Agent): DraftState {
  return {
    name: a.name,
    description: a.description,
    system_prompt: a.system_prompt,
    providerChoice: agentEditorProviderFromAgent(a.model.provider, a.model.model),
    provider: a.model.provider,
    model: a.model.model,
    temperature: a.temperature ?? 0.7,
  };
}

function draftDiffers(d: DraftState, a: Agent): boolean {
  const base = agentToDraft(a);
  return (
    d.name !== base.name ||
    d.description !== base.description ||
    d.system_prompt !== base.system_prompt ||
    d.providerChoice !== base.providerChoice ||
    d.provider !== base.provider ||
    d.model !== base.model ||
    d.temperature !== base.temperature
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

  const apiKeys = useAuthStore((s) => s.apiKeys);
  const offlineMode = useAuthStore((s) => s.offlineMode);
  const plan = useAuthStore((s) => s.plan);
  const defaultProvider = useAuthStore((s) => s.defaultProvider);
  const ollamaOptions = useOllamaModelOptions();

  React.useEffect(() => {
    let cancelled = false;
    void import('@/lib/ai/providers/ollama').then(({ listOllamaModels, isOllamaReachable }) =>
      isOllamaReachable().then((connected) => {
        if (!connected || cancelled) return;
        return listOllamaModels().then((models) => {
          if (!cancelled) syncDiscoveredOllamaModels(models);
        });
      }),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const providerOptions = React.useMemo(
    () => getAgentEditorProviderOptions({ apiKeys, offlineMode, plan, defaultProvider }),
    [apiKeys, offlineMode, plan, defaultProvider, ollamaOptions],
  );

  const modelOptions = React.useMemo(() => {
    if (!draft || draft.providerChoice === 'default') return [];
    return getAccessibleModelOptions(
      draft.providerChoice,
      apiKeys,
      offlineMode,
      useAuthStore.getState().defaultLocalModel,
      plan,
    );
  }, [draft, apiKeys, offlineMode, plan, ollamaOptions]);

  const dirty = !!(draft && selectedAgent && draftDiffers(draft, selectedAgent));

  const handleProviderChoice = (choice: AgentEditorProviderChoice) => {
    if (!draft) return;
    const nextModel = agentModelFromEditorChoice(
      choice,
      draft.provider,
      draft.model,
      apiKeys,
      offlineMode,
      plan,
      useAuthStore.getState().defaultLocalModel,
    );
    setDraft({
      ...draft,
      providerChoice: choice,
      provider: nextModel.provider,
      model: nextModel.model,
    });
  };

  const handleSave = async () => {
    if (!selectedAgent || !draft || !dirty) return;
    const patch: Partial<Agent> = {
      name: draft.name,
      description: draft.description,
      system_prompt: draft.system_prompt,
      model: { ...selectedAgent.model, provider: draft.provider, model: draft.model },
      temperature: draft.temperature,
    };
    try {
      const saved = await agentRepo.update(selectedAgent.id, patch);
      updateAgent(selectedAgent.id, saved);
      toast.success('Saved', `Updated "${draft.name}"`);
    } catch (err) {
      toast.error('Save failed', err instanceof Error ? err.message : 'Could not save this agent.');
    }
  };

  const handleReset = () => {
    if (!selectedAgent) return;
    setDraft(agentToDraft(selectedAgent));
  };

  const handleClone = async () => {
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
    try {
      const saved = await agentRepo.create(cloned);
      registerAgent(saved);
      setSelectedId(saved.id);
      toast.success('Cloned', `Created "${saved.name}"`);
    } catch (err) {
      toast.error('Clone failed', err instanceof Error ? err.message : 'Could not clone this agent.');
    }
  };

  const handleDelete = async () => {
    if (!selectedAgent || selectedAgent.builtin) return;
    const name = selectedAgent.name;
    try {
      await agentRepo.delete(selectedAgent.id);
      unregisterAgent(selectedAgent.id);
      toast.info('Deleted', `Removed "${name}"`);
    } catch (err) {
      toast.error('Delete failed', err instanceof Error ? err.message : 'Could not delete this agent.');
    }
  };

  const seedDefaults = () => {
    const defaults = getDefaultAgents();
    registerMany(defaults);
    toast.success('Loaded', `${defaults.length} default agents added`);
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
              const role = getAgentRole(agent);
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
                  {role && <RolePill role={role} />}
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
                  <div className="flex items-center gap-2">
                    <div className="text-page-title text-foreground truncate">
                      {selectedAgent.name}
                    </div>
                    {(() => {
                      const role = getAgentRole(selectedAgent);
                      return role ? <RolePill role={role} /> : null;
                    })()}
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
                    value={draft.providerChoice}
                    onChange={(e) =>
                      handleProviderChoice(e.target.value as AgentEditorProviderChoice)
                    }
                    className={cn(
                      'flex h-8 w-full rounded-md border border-input bg-background px-2 text-body text-foreground',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      'transition-colors',
                    )}
                  >
                    {providerOptions.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="agent-model">Model</Label>
                  {draft.providerChoice === 'default' ? (
                    <p
                      id="agent-model"
                      className="flex h-8 items-center rounded-md border border-dashed border-border px-2 text-secondary text-muted-foreground"
                    >
                      Follows Settings → Providers → Default provider
                    </p>
                  ) : modelOptions.length > 0 ? (
                    <select
                      id="agent-model"
                      value={draft.model}
                      onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                      className={cn(
                        'flex h-8 w-full rounded-md border border-input bg-background px-2 text-body text-foreground',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                        'transition-colors',
                      )}
                    >
                      {modelOptions.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p
                      id="agent-model"
                      className="flex min-h-8 items-center rounded-md border border-dashed border-accent-copper/35 bg-accent-copper/5 px-2 text-secondary text-muted-foreground"
                    >
                      {ollamaOptions.length > 0
                        ? 'Scanning local models…'
                        : 'No models available — open Settings → Local Models to download one'}
                    </p>
                  )}
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
