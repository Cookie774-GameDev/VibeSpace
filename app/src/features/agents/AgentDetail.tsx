/**
 * AgentDetail — the `'agent-detail'` route.
 *
 * Reachable from the nav sidebar by clicking an agent row. Replaces
 * the legacy "click an agent → spin up a fresh chat" behaviour with a
 * proper read-only summary card: who the agent is, the system prompt,
 * provider/model, capabilities, plus a prominent "Start chat" button
 * that performs the old action explicitly. From here the user can also
 * jump to the full agent editor (`AgentManager`) to tweak the system
 * prompt or model.
 *
 * Reads the active agent from `useUIStore.activeAgentId` (set by
 * `NavPane.onClickAgent`). Falls back to the agent list when the id
 * is unset or stale.
 *
 * Why a separate page instead of merging into `AgentManager`:
 *   - The user explicitly wanted the agent click to land on a "details
 *     page" first, not the editor. Editing should be one click further.
 *   - The summary view is the same component you'd want to surface
 *     from a "preview agent" affordance later (e.g. a hover card on
 *     the @-mention picker).
 */

import * as React from 'react';
import {
  ArrowLeft,
  MessageSquare,
  Pencil,
  Sparkles,
  Bot,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/toast';
import { AgentBadge } from './AgentBadge';
import { useAgentStore } from '@/stores/agents';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { chatRepo } from '@/lib/db';
import type { AgentId, Agent, ProjectId, WorkspaceId } from '@/types';
import { getAgentRole, ROLE_PERSONAS } from './personas';

export function AgentDetail() {
  const agents = useAgentStore((s) => s.agents);
  const activeAgentId = useUIStore((s) => s.activeAgentId);
  const setActiveAgent = useUIStore((s) => s.setActiveAgent);
  const setRoute = useUIStore((s) => s.setRoute);
  const setActiveChat = useUIStore((s) => s.setActiveChat);
  const setChatMode = useUIStore((s) => s.setChatMode);

  const workspaceId = useAuthStore((s) => s.workspaceId) as WorkspaceId | null;
  const projectId = useAuthStore((s) => s.projectId) as ProjectId | null;

  const agent: Agent | null = activeAgentId
    ? agents[activeAgentId as AgentId] ?? null
    : null;

  const handleBack = () => {
    setRoute('agents');
  };

  const handleEdit = () => {
    setRoute('agents');
  };

  const handleStartChat = async () => {
    if (!agent) return;
    if (!workspaceId) {
      toast.warning('Still loading', 'Workspace is initializing — try again in a sec.');
      return;
    }
    try {
      const chat = await chatRepo.create({
        workspace_id: workspaceId,
        project_id: projectId ?? undefined,
        title: `Chat with ${agent.name}`,
        mode: 'chat',
        active_agent_ids: [agent.id],
      });
      setActiveChat(chat.id);
      setChatMode('chat');
      setRoute('chat');
      toast.success(`@${agent.slug} ready`, `New chat started with ${agent.name}.`);
    } catch (err) {
      toast.error(
        'Could not start chat',
        err instanceof Error ? err.message : 'Try again.',
      );
    }
  };

  // No agent selected → fall back to the manager. Friendlier than a
  // blank page; lets the user pick another agent without clicking back.
  if (!agent) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-paper-warm p-8">
        <div className="bg-paper rounded-lg shadow-soft p-10 max-w-md text-center space-y-4">
          <Bot className="mx-auto h-10 w-10 text-muted-foreground/60" />
          <div className="text-page-title text-foreground">No agent selected</div>
          <p className="text-secondary text-muted-foreground">
            Pick an agent from the sidebar to see its details, or open the
            agent manager to browse all agents.
          </p>
          <Button
            variant="accent"
            size="sm"
            onClick={() => {
              setActiveAgent(null);
              setRoute('agents');
            }}
          >
            Open agent manager
          </Button>
        </div>
      </div>
    );
  }

  const role = getAgentRole(agent);
  const persona = role ? ROLE_PERSONAS[role] : null;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      {/* Compact toolbar — back arrow + actions */}
      <div className="shrink-0 flex items-center justify-between gap-3 px-3 py-1 border-b border-border bg-paper-soft">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleBack}
            aria-label="Back to agents"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="font-display text-foreground text-secondary tracking-tight">
            Agent
          </span>
          <span aria-hidden className="text-border-mid">·</span>
          <span className="font-mono text-metadata text-muted-foreground">
            {agent.slug}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={handleEdit}>
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
          <Button variant="accent" size="sm" onClick={() => void handleStartChat()}>
            <MessageSquare className="h-3.5 w-3.5" />
            Start chat
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl p-6 space-y-6">
          {/* Header card */}
          <div className="surface-panel rounded-lg p-5 flex items-start gap-4">
            <AgentBadge agent={agent} showName={false} size="lg" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="font-display text-page-title text-foreground truncate">
                  {agent.name}
                </h1>
                {agent.builtin && (
                  <Badge variant="outline" className="text-metadata">
                    Built-in
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-secondary text-muted-foreground">
                {agent.description}
              </p>
              {persona && (
                <p className="mt-2 text-metadata text-muted-foreground/80">
                  <Sparkles className="inline h-3 w-3 mr-1 text-accent-copper" />
                  {persona.oneLiner}
                </p>
              )}
            </div>
          </div>

          {/* Provider / model / temperature card */}
          <div className="surface-panel rounded-lg p-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <div className="text-metadata uppercase tracking-wider text-muted-foreground mb-1">
                  Provider
                </div>
                <div className="text-secondary text-foreground font-mono">
                  {agent.model.provider}
                </div>
              </div>
              <div>
                <div className="text-metadata uppercase tracking-wider text-muted-foreground mb-1">
                  Model
                </div>
                <div className="text-secondary text-foreground font-mono truncate">
                  {agent.model.model}
                </div>
              </div>
              <div>
                <div className="text-metadata uppercase tracking-wider text-muted-foreground mb-1">
                  Temperature
                </div>
                <div className="text-secondary text-foreground font-mono">
                  {(agent.temperature ?? 0.7).toFixed(2)}
                </div>
              </div>
            </div>

            <Separator className="my-4" />

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <div className="text-metadata uppercase tracking-wider text-muted-foreground mb-1.5">
                  Capabilities
                </div>
                <div className="flex flex-wrap gap-1">
                  {agent.capabilities.length === 0 ? (
                    <span className="text-metadata text-muted-foreground">none</span>
                  ) : (
                    agent.capabilities.map((c) => (
                      <Badge key={c} variant="secondary" className="text-metadata">
                        {c}
                      </Badge>
                    ))
                  )}
                </div>
              </div>
              <div>
                <div className="text-metadata uppercase tracking-wider text-muted-foreground mb-1.5">
                  Memory scope
                </div>
                <Badge variant="outline">{agent.memory_scope}</Badge>
              </div>
            </div>
          </div>

          {/* System prompt card */}
          <div className="surface-panel rounded-lg p-5">
            <div className="flex items-center justify-between mb-2">
              <div className="text-ui-strong text-foreground">System prompt</div>
              <div className="text-metadata text-muted-foreground">
                {agent.system_prompt.length.toLocaleString()} chars · ~
                {Math.ceil(agent.system_prompt.length / 4).toLocaleString()} tokens
              </div>
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-secondary leading-relaxed text-foreground/90 bg-paper-soft rounded-md p-4 border border-border max-h-[420px] overflow-y-auto">
              {agent.system_prompt}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AgentDetail;
