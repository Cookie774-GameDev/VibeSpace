/**
 * ProjectDetail — the `'project-detail'` route.
 *
 * Reachable from the nav sidebar via the "+" next to "Projects"
 * (creates a new project then jumps here) or by clicking the gear on
 * an existing project. Owns:
 *
 *   - rename / colour-hue / icon
 *   - the project's system-prompt context blob (prepended to every AI
 *     request that fires while this project is active)
 *   - the no-context-mode toggle (skip the prepend for clean-room runs)
 *   - the curated agent allowlist (`allowed_agent_slugs` on the row)
 *
 * Reads the active project from `useAuthStore.projectId`. The project
 * record itself comes from `projectRepo` via `useLiveQuery` so edits
 * in another tab / the assistant flow stay reflected here without a
 * manual refresh.
 *
 * Persistence: `projectRepo.update` (Dexie). The Supabase mirror is
 * additive and lags; this page never blocks on cloud writes.
 */

import * as React from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowLeft,
  Save,
  RotateCcw,
  Trash2,
  AlertTriangle,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toast';

import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { useAgentStore } from '@/stores/agents';
import { projectRepo, chatRepo } from '@/lib/db';
import type { Project } from '@/lib/db/schema';
import type { ProjectId, WorkspaceId } from '@/types';
import { cn } from '@/lib/utils';

interface DraftState {
  name: string;
  color_hue: number;
  system_prompt_context: string;
  no_context_mode: boolean;
  allowed_agent_slugs: string[];
}

function projectToDraft(p: Project): DraftState {
  return {
    name: p.name,
    color_hue: p.color_hue ?? 210,
    system_prompt_context: p.system_prompt_context ?? '',
    no_context_mode: Boolean(p.no_context_mode),
    allowed_agent_slugs: p.allowed_agent_slugs ?? [],
  };
}

function draftDiffers(d: DraftState, p: Project): boolean {
  return (
    d.name !== p.name ||
    d.color_hue !== (p.color_hue ?? 210) ||
    d.system_prompt_context !== (p.system_prompt_context ?? '') ||
    d.no_context_mode !== Boolean(p.no_context_mode) ||
    d.allowed_agent_slugs.length !== (p.allowed_agent_slugs?.length ?? 0) ||
    d.allowed_agent_slugs.some(
      (s, i) => s !== (p.allowed_agent_slugs ?? [])[i],
    )
  );
}

export function ProjectDetail() {
  const projectId = useAuthStore((s) => s.projectId) as ProjectId | null;
  const workspaceId = useAuthStore((s) => s.workspaceId) as WorkspaceId | null;
  const setProjectId = useAuthStore((s) => s.setProjectId);
  const setRoute = useUIStore((s) => s.setRoute);

  const agents = useAgentStore((s) => s.agents);
  const agentList = React.useMemo(() => Object.values(agents), [agents]);

  const project = useLiveQuery(
    () => (projectId ? projectRepo.getById(projectId) : Promise.resolve(undefined)),
    [projectId],
    undefined as Project | undefined,
  );

  // Chat count for the danger-zone confirm copy.
  const chatCount = useLiveQuery(
    async () => {
      if (!projectId) return 0;
      const rows = await chatRepo.listByProject(projectId);
      return rows.length;
    },
    [projectId],
    0,
  );

  const [draft, setDraft] = React.useState<DraftState | null>(null);
  React.useEffect(() => {
    if (project) setDraft(projectToDraft(project));
  }, [project?.id, project?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !!(project && draft && draftDiffers(draft, project));

  const handleBack = () => {
    setRoute('chat');
  };

  const handleSave = async () => {
    if (!project || !draft || !dirty) return;
    try {
      await projectRepo.update(project.id, {
        name: draft.name.trim() || project.name,
        color_hue: draft.color_hue,
        system_prompt_context: draft.system_prompt_context,
        no_context_mode: draft.no_context_mode,
        allowed_agent_slugs:
          draft.allowed_agent_slugs.length > 0
            ? draft.allowed_agent_slugs
            : undefined,
      });
      toast.success('Project saved', `Updated "${draft.name}".`);
    } catch (err) {
      toast.error('Save failed', err instanceof Error ? err.message : 'Try again.');
    }
  };

  const handleReset = () => {
    if (project) setDraft(projectToDraft(project));
  };

  const toggleAgent = (slug: string) => {
    if (!draft) return;
    const next = draft.allowed_agent_slugs.includes(slug)
      ? draft.allowed_agent_slugs.filter((s) => s !== slug)
      : [...draft.allowed_agent_slugs, slug];
    setDraft({ ...draft, allowed_agent_slugs: next });
  };

  const handleDelete = async () => {
    if (!project || !workspaceId) return;
    const remaining = await projectRepo.listByWorkspace(workspaceId);
    if (remaining.length <= 1) {
      toast.warning(
        "Can't delete",
        'You need at least one project. Create another first.',
      );
      return;
    }
    const ok = window.confirm(
      `Delete "${project.name}"?\n\n` +
        `${chatCount ?? 0} chat${chatCount === 1 ? '' : 's'} in this project will be unassigned ` +
        `(not deleted) and become visible from the default project.`,
    );
    if (!ok) return;
    try {
      // Unassign chats first so they don't dangle.
      const chats = await chatRepo.listByProject(project.id);
      for (const c of chats) {
        await chatRepo.update(c.id, { project_id: undefined });
      }
      await projectRepo.delete(project.id);
      // Switch to the next project so the workspace doesn't sit on a
      // deleted id.
      const fallback = remaining.find((p) => p.id !== project.id) ?? remaining[0]!;
      setProjectId(fallback.id);
      toast.success('Project deleted', `Removed "${project.name}".`);
      setRoute('chat');
    } catch (err) {
      toast.error('Delete failed', err instanceof Error ? err.message : 'Try again.');
    }
  };

  if (!projectId || !project || !draft) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-paper-warm p-8">
        <div className="bg-paper rounded-lg shadow-soft p-10 max-w-md text-center space-y-3">
          <div className="text-page-title text-foreground">No project selected</div>
          <p className="text-secondary text-muted-foreground">
            Pick a project from the sidebar, or create a new one with the
            "+" button.
          </p>
          <Button variant="accent" size="sm" onClick={handleBack}>
            Back to chat
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <div className="shrink-0 flex items-center justify-between gap-3 px-3 py-1 border-b border-border bg-paper-soft">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleBack}
            aria-label="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="font-display text-foreground text-secondary tracking-tight">
            Project
          </span>
          <span aria-hidden className="text-border-mid">·</span>
          <span
            aria-hidden
            className="h-2 w-2 rounded-full shrink-0"
            style={{ background: `hsl(${draft.color_hue} 65% 56%)` }}
          />
          <span className="text-secondary text-foreground truncate max-w-[40ch]">
            {draft.name || 'Untitled project'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={handleReset} disabled={!dirty}>
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </Button>
          <Button
            variant="accent"
            size="sm"
            onClick={() => void handleSave()}
            disabled={!dirty}
          >
            <Save className="h-3.5 w-3.5" />
            Save
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl p-6 space-y-6">
          {/* Identity */}
          <section className="surface-panel rounded-lg p-5 space-y-4">
            <div className="text-ui-strong text-foreground">Identity</div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="proj-name">Name</Label>
                <Input
                  id="proj-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="My project"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="proj-hue">
                  Colour hue
                  <span className="ml-2 font-mono text-metadata text-muted-foreground">
                    {draft.color_hue}°
                  </span>
                </Label>
                <input
                  id="proj-hue"
                  type="range"
                  min={0}
                  max={359}
                  step={1}
                  value={draft.color_hue}
                  onChange={(e) =>
                    setDraft({ ...draft, color_hue: Number(e.target.value) })
                  }
                  className="w-full"
                  style={{ accentColor: `hsl(${draft.color_hue} 65% 56%)` }}
                />
              </div>
            </div>
          </section>

          {/* Context */}
          <section className="surface-panel rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-ui-strong text-foreground">
                  Project context
                </div>
                <p className="text-metadata text-muted-foreground mt-0.5">
                  Prepended to every AI request that fires while this project
                  is active. Use it for paths, conventions, DB schema —
                  anything every agent should know.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Label
                  htmlFor="proj-no-ctx"
                  className="text-metadata text-muted-foreground"
                >
                  No-context mode
                </Label>
                <Switch
                  id="proj-no-ctx"
                  checked={draft.no_context_mode}
                  onCheckedChange={(v) =>
                    setDraft({ ...draft, no_context_mode: Boolean(v) })
                  }
                  aria-label="Toggle no-context mode"
                />
              </div>
            </div>
            <Textarea
              value={draft.system_prompt_context}
              onChange={(e) =>
                setDraft({ ...draft, system_prompt_context: e.target.value })
              }
              placeholder="e.g. We use Postgres on Neon, Tailwind v4, and pnpm. The user prefers concise replies. Do not edit migrations without asking."
              className={cn(
                'min-h-[200px] font-mono text-secondary leading-relaxed',
                draft.no_context_mode && 'opacity-60',
              )}
              disabled={draft.no_context_mode}
            />
            <div className="text-metadata text-muted-foreground flex items-center justify-between">
              <span>
                {draft.system_prompt_context.length.toLocaleString()} chars · ~
                {Math.ceil(draft.system_prompt_context.length / 4).toLocaleString()} tokens
              </span>
              {draft.no_context_mode && (
                <span className="inline-flex items-center gap-1.5 text-accent-copper">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Context is disabled — agents won't see this blob.
                </span>
              )}
            </div>
          </section>

          {/* Agents */}
          <section className="surface-panel rounded-lg p-5 space-y-4">
            <div>
              <div className="text-ui-strong text-foreground">Allowed agents</div>
              <p className="text-metadata text-muted-foreground mt-0.5">
                Optional. When empty, every agent is available in this
                project. Pick one or more to narrow the picker for this
                project's workflows.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {agentList.length === 0 ? (
                <span className="text-metadata text-muted-foreground">
                  No agents loaded.
                </span>
              ) : (
                agentList.map((a) => {
                  const checked = draft.allowed_agent_slugs.includes(a.slug);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => toggleAgent(a.slug)}
                      className={cn(
                        'group flex items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors',
                        checked
                          ? 'border-accent-copper/40 bg-elevated'
                          : 'border-border bg-panel hover:bg-muted/50',
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'h-3 w-3 shrink-0 rounded-sm border',
                          checked
                            ? 'border-accent-copper bg-accent-copper'
                            : 'border-border bg-background',
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-secondary text-foreground truncate">
                          {a.name}
                        </span>
                        <span className="block text-metadata text-muted-foreground truncate">
                          @{a.slug}
                        </span>
                      </span>
                      {a.builtin && (
                        <Badge variant="outline" className="text-metadata">
                          Built-in
                        </Badge>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </section>

          <Separator />

          {/* Danger zone */}
          <section className="rounded-lg border border-destructive/30 bg-destructive/5 p-5 space-y-2">
            <div className="text-ui-strong text-destructive">Danger zone</div>
            <p className="text-metadata text-muted-foreground">
              Deleting a project unassigns its chats but does not delete them.
              Terminals belonging to this project are dropped from
              localStorage on next mount.
            </p>
            <div>
              <Button
                variant="outline"
                size="sm"
                className="border-destructive/40 text-destructive hover:bg-destructive/10"
                onClick={() => void handleDelete()}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete project
              </Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export default ProjectDetail;
