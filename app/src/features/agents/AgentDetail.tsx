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
import { ArrowLeft, MessageSquare, Pencil, Sparkles, Bot } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/toast';
import { AgentBadge } from './AgentBadge';
import { useAgentStore } from '@/stores/agents';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { chatRepo } from '@/lib/db';
import { jarvisProfileRepo } from '@/lib/db/jarvisRepositories';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { isProtectedJarvisAgent } from '@/lib/jarvis/identity';
import './sakura-agents.css';
import type { AgentId, Agent, ProjectId, WorkspaceId } from '@/types';
import { getProviderDisplayName } from '@/lib/ai/providerRegistry';
import { getModelLabelForProvider } from '@/lib/ai/providerModelCatalog';
import { useProviderConnectionContext } from '@/lib/ai/useProviderModelOptions';
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
  const cloudSession = useAuthStore((s) => s.cloudSession);
  const localUserId = useAuthStore((s) => s.localUserId);
  const providerCtx = useProviderConnectionContext();

  const agent: Agent | null = activeAgentId ? (agents[activeAgentId as AgentId] ?? null) : null;
  const protectedJarvis = agent !== null && isProtectedJarvisAgent(agent);
  const accountIdentity = resolveAccountIdentity({ cloudSession, localUserId });
  const accountId = accountIdentity?.accountId ?? null;
  const accountScopeKey = accountIdentity
    ? `${accountIdentity.source}\u0000${accountIdentity.accountId}`
    : null;
  const profileLoadGeneration = React.useRef(0);
  const [protectedProfile, setProtectedProfile] = React.useState<{
    accountScopeKey: string;
    customInstructions: string;
  } | null>(null);

  React.useEffect(() => {
    const generation = ++profileLoadGeneration.current;
    setProtectedProfile(null);
    if (!protectedJarvis || accountId === null || accountScopeKey === null) return;

    void jarvisProfileRepo
      .getActive(accountId)
      .then((profile) => {
        if (profileLoadGeneration.current !== generation) return;
        if (!profile || profile.accountId !== accountId) return;
        setProtectedProfile({
          accountScopeKey,
          customInstructions: profile.customInstructions,
        });
      })
      .catch(() => {
        // Missing or unavailable profile state remains a bounded loading view.
      });

    return () => {
      if (profileLoadGeneration.current === generation) {
        profileLoadGeneration.current += 1;
      }
    };
  }, [accountId, accountScopeKey, protectedJarvis]);

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
      toast.error('Could not start chat', err instanceof Error ? err.message : 'Try again.');
    }
  };

  // No agent selected → fall back to the manager. Friendlier than a
  // blank page; lets the user pick another agent without clicking back.
  if (!agent) {
    return (
      <div
        data-monochrome-route="agent-detail"
        data-monochrome-state="empty"
        className="flex h-full w-full items-center justify-center bg-paper-warm p-8 [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:bg-none"
      >
        <div className="bg-paper rounded-lg shadow-soft p-10 max-w-md text-center space-y-4 [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none">
          <Bot className="mx-auto h-10 w-10 text-muted-foreground/60" />
          <div className="text-page-title text-foreground">No agent selected</div>
          <p className="text-secondary text-muted-foreground">
            Pick an agent from the sidebar to see its details, or open the agent manager to browse
            all agents.
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
  const protectedInstructions =
    protectedJarvis &&
    accountScopeKey !== null &&
    protectedProfile?.accountScopeKey === accountScopeKey
      ? protectedProfile.customInstructions
      : null;
  const promptLabel = protectedJarvis ? 'Custom instructions' : 'System prompt';
  const displayedPrompt = protectedJarvis ? protectedInstructions : agent.system_prompt;

  return (
    <div
      data-monochrome-route="agent-detail"
      className="flex h-full w-full flex-col overflow-hidden bg-background"
    >
      {/* Compact toolbar — back arrow + actions */}
      <div
        data-monochrome-surface="agent-toolbar"
        className="shrink-0 flex items-center justify-between gap-3 px-3 py-1 border-b border-border bg-paper-soft [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none"
      >
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={handleBack} aria-label="Back to agents">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="font-display text-foreground text-secondary tracking-tight [html[data-theme=monochrome]_&]:font-mono [html[data-theme=monochrome]_&]:uppercase [html[data-theme=monochrome]_&]:tracking-wide">
            Agent
          </span>
          <span aria-hidden className="text-border-mid">
            ·
          </span>
          <span className="font-mono text-metadata text-muted-foreground">{agent.slug}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={handleEdit}>
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
          <Button
            variant="accent"
            size="sm"
            onClick={() => void handleStartChat()}
            className="[html[data-theme=monochrome]_&]:bg-none"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Start chat
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl p-6 space-y-6 [html[data-theme=monochrome]_&]:space-y-3">
          {/* Header card */}
          <div
            data-monochrome-surface="agent-identity"
            className="surface-panel rounded-lg p-5 flex items-start gap-4 [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border [html[data-theme=monochrome]_&]:border-border [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none"
          >
            <AgentBadge
              agent={agent}
              showName={false}
              size="lg"
              className="[html[data-theme=monochrome]_&_[data-vibespace-avatar]]:bg-none"
            />
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
              <p className="mt-1 text-secondary text-muted-foreground">{agent.description}</p>
              {persona && (
                <p className="mt-2 text-metadata text-muted-foreground/80">
                  <Sparkles className="inline h-3 w-3 mr-1 text-accent-copper" />
                  {persona.oneLiner}
                </p>
              )}
            </div>
          </div>

          {/* Provider / model / temperature card */}
          <div
            data-monochrome-surface="agent-manifest"
            className="surface-panel rounded-lg p-5 [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border [html[data-theme=monochrome]_&]:border-border [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none"
          >
            <div className="grid gap-4 sm:grid-cols-3">
              {!agent.builtin ? (
                <>
                  <div>
                    <div className="text-metadata uppercase tracking-wider text-muted-foreground mb-1">
                      Provider
                    </div>
                    <div className="text-secondary text-foreground">
                      {getProviderDisplayName(agent.model.provider)}
                    </div>
                  </div>
                  <div>
                    <div className="text-metadata uppercase tracking-wider text-muted-foreground mb-1">
                      Model
                    </div>
                    <div className="text-secondary text-foreground truncate">
                      {getModelLabelForProvider(
                        agent.model.provider,
                        agent.model.model,
                        providerCtx,
                      )}
                    </div>
                    <div className="font-mono text-[11px] text-muted-foreground truncate">
                      {agent.model.model}
                    </div>
                  </div>
                </>
              ) : null}
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

          {/* Prompt / protected profile instructions card */}
          <div
            data-monochrome-surface="agent-instructions"
            data-monochrome-state={displayedPrompt === null ? 'loading' : 'ready'}
            className="surface-panel rounded-lg p-5 [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border [html[data-theme=monochrome]_&]:border-border [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none"
          >
            <div className="flex items-center justify-between mb-2">
              <div className="text-ui-strong text-foreground">{promptLabel}</div>
              <div className="text-metadata text-muted-foreground">
                {(displayedPrompt ?? '').length.toLocaleString()} chars · ~
                {Math.ceil((displayedPrompt ?? '').length / 4).toLocaleString()} tokens
              </div>
            </div>
            {displayedPrompt === null ? (
              <div
                role="status"
                className="font-mono text-secondary text-muted-foreground bg-paper-soft rounded-md p-4 border border-border [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-dashed [html[data-theme=monochrome]_&]:bg-background"
              >
                Profile is still loading
              </div>
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-secondary leading-relaxed text-foreground/90 bg-paper-soft rounded-md p-4 border border-border max-h-[420px] overflow-y-auto [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:bg-background">
                {protectedJarvis && !displayedPrompt.trim()
                  ? 'No custom instructions saved for this agent. Its built-in behavior still applies.'
                  : displayedPrompt}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default AgentDetail;
