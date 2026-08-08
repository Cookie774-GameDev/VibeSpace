import * as React from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Activity,
  Bot,
  Copy,
  Download,
  ExternalLink,
  FileUp,
  FolderKey,
  Globe2,
  KeyRound,
  LockKeyhole,
  MonitorUp,
  Plus,
  ShieldCheck,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { ensureActiveChat } from '@/features/chat/chatLifecycle';
import { formatContextTreeForPrompt, loadSelectedContextMap } from '@/features/context';
import { selectPluginConnectionsForAccount, usePluginStore } from '@/features/plugins/store';
import { taskbarUsageStore } from '@/features/taskbar-usage/taskbarUsageStore';
import { agentRepo, db, projectRepo } from '@/lib/db';
import { getStoredProjectRoot, basename } from '@/features/files/projectFiles';
import {
  resolveBrowserChatCloudUrl,
  resolveBrowserChatMcpUrl,
  setBridgeWorkspaceGrant,
  useBrowserChatRelay,
} from '@/lib/bridge';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { BrowserProviderSurface } from './BrowserProviderSurface';
import { useBrowserChatStore } from './browserChatStore';
import { BROWSER_CHAT_PROVIDERS, browserChatProvider } from './providerRegistry';
import { browserChatSurface } from './providerSurface';
import { buildBrowserAgentPrompt } from './browserAgentPrompt';
import {
  browserChatWorkspaceGrantStore,
  grantBrowserChatWorkspace,
  revokeBrowserChatWorkspace,
} from './workspaceGrant';

function statusLabel(value: string): string {
  return value.replaceAll('_', ' ');
}

const stagedFilesByChat = new Map<string, File[]>();

function usageText(value: number | null, limit: number | null, unit: string | null): string {
  if (value === null || limit === null || !unit) {
    return 'ChatGPT web quota is not exposed to VibeSpace.';
  }
  return `${value.toLocaleString()} of ${limit.toLocaleString()} ${unit}`;
}

export function BrowserChatHub({ chatId }: { readonly chatId?: string | null }) {
  const providerId = useBrowserChatStore(
    (state) => state.chatPreferences[chatId ?? '']?.providerId ?? state.providerId,
  );
  const setProvider = useBrowserChatStore((state) => state.setProvider);
  const setEngine = useBrowserChatStore((state) => state.setEngine);
  const runtime = useBrowserChatStore((state) => state.providerRuntime[providerId]);
  const provider = browserChatProvider(providerId);
  const pageStatus = runtime?.pageStatus ?? provider.pageStatus;
  const providerBridgeStatus = runtime?.toolBridgeStatus ?? provider.toolBridgeStatus;
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const projectId = useAuthStore((state) => state.projectId);
  const accountId = useAuthStore((state) => state.cloudSession?.user_id ?? state.localUserId ?? '');
  const workspaceGrant = React.useSyncExternalStore(
    browserChatWorkspaceGrantStore.subscribe,
    browserChatWorkspaceGrantStore.getSnapshot,
    () => null,
  );
  const projectRoot = getStoredProjectRoot(projectId);
  const activeWorkspaceGrant =
    workspaceGrant?.accountId === accountId && workspaceGrant.projectId === projectId
      ? workspaceGrant
      : null;
  const relayStatus = useBrowserChatRelay(Boolean(activeWorkspaceGrant));
  const mcpUrl = resolveBrowserChatMcpUrl(
    resolveBrowserChatCloudUrl(import.meta.env as Record<string, string | undefined>),
  );
  const bridgeStatus =
    relayStatus === 'connected' || relayStatus === 'connecting' || relayStatus === 'reconnecting'
      ? relayStatus
      : providerBridgeStatus;
  const setActiveChat = useUIStore((state) => state.setActiveChat);
  const chatPreferences = useBrowserChatStore((state) => state.chatPreferences);
  const browserChatIds = React.useMemo(
    () =>
      Object.entries(chatPreferences)
        .filter(([, preference]) => preference.engine === 'browser')
        .map(([id]) => id),
    [chatPreferences],
  );
  const sessions = useLiveQuery(
    async () => {
      if (!workspaceId || browserChatIds.length === 0) return [];
      const rows = await db.chats.where('workspace_id').equals(workspaceId).toArray();
      const ids = new Set(browserChatIds);
      return rows
        .filter((chat) => ids.has(chat.id))
        .sort((left, right) => right.updated_at - left.updated_at)
        .slice(0, 20);
    },
    [workspaceId, browserChatIds.join('|')],
    [],
  );
  const connections = usePluginStore((state) =>
    selectPluginConnectionsForAccount(state, accountId),
  );
  const enabledConnections = React.useMemo(
    () =>
      Object.values(connections)
        .filter((connection) => connection.enabled)
        .sort((left, right) => left.pluginId.localeCompare(right.pluginId)),
    [connections],
  );
  const usageState = React.useSyncExternalStore(
    taskbarUsageStore.subscribe,
    taskbarUsageStore.getSnapshot,
    taskbarUsageStore.getSnapshot,
  );
  const openAiUsage = usageState.payload.snapshots.find(
    (snapshot) =>
      snapshot.providerId === 'openai' ||
      snapshot.providerFamilyId === 'openai' ||
      snapshot.displayName.toLowerCase() === 'openai',
  );
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [stagedFiles, setStagedFiles] = React.useState<File[]>(() =>
    chatId ? (stagedFilesByChat.get(chatId) ?? []) : [],
  );
  const agents = useLiveQuery(() => agentRepo.list(), [], []);
  const project = useLiveQuery(
    () => (projectId ? projectRepo.getById(projectId) : Promise.resolve(undefined)),
    [projectId],
    undefined,
  );
  const [selectedAgentId, setSelectedAgentId] = React.useState('');
  const [contextRevision, setContextRevision] = React.useState(0);
  const contextMap = React.useMemo(
    () => loadSelectedContextMap(projectId),
    [contextRevision, projectId],
  );
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0] ?? null;
  const agentPrompt = React.useMemo(
    () =>
      selectedAgent
        ? buildBrowserAgentPrompt({
            agent: selectedAgent,
            projectName: project?.name,
            projectContext: project?.no_context_mode ? '' : project?.system_prompt_context,
            contextMap,
            formattedContextMap: contextMap ? formatContextTreeForPrompt(contextMap.tree) : '',
          })
        : '',
    [contextMap, project, selectedAgent],
  );

  React.useEffect(() => {
    if (!selectedAgentId && agents[0]) setSelectedAgentId(agents[0].id);
  }, [agents, selectedAgentId]);

  React.useEffect(() => {
    const refreshContext = () => setContextRevision((revision) => revision + 1);
    window.addEventListener('jarvis:context-tree-updated', refreshContext);
    return () => window.removeEventListener('jarvis:context-tree-updated', refreshContext);
  }, []);

  React.useEffect(() => {
    setStagedFiles(chatId ? (stagedFilesByChat.get(chatId) ?? []) : []);
  }, [chatId]);

  React.useEffect(() => {
    if (
      workspaceGrant &&
      (workspaceGrant.accountId !== accountId || workspaceGrant.projectId !== projectId)
    ) {
      revokeBrowserChatWorkspace();
      setBridgeWorkspaceGrant();
    }
  }, [accountId, projectId, workspaceGrant]);

  const stageFiles = (files: FileList | null) => {
    if (!chatId || !files) return;
    const next = [
      ...(stagedFilesByChat.get(chatId) ?? []),
      ...Array.from(files).filter(
        (file) =>
          !(stagedFilesByChat.get(chatId) ?? []).some(
            (current) =>
              current.name === file.name &&
              current.size === file.size &&
              current.lastModified === file.lastModified,
          ),
      ),
    ].slice(0, 24);
    stagedFilesByChat.set(chatId, next);
    setStagedFiles(next);
  };

  const createBrowserChat = async () => {
    const nextId = await ensureActiveChat({
      forceNew: true,
      title: 'ChatGPT browser chat',
    });
    if (!nextId) return;
    setEngine('browser', nextId);
    setProvider('chatgpt', nextId);
  };

  const approveProjectRead = () => {
    if (!accountId || !projectId || !projectRoot) {
      toast.error(
        'Project access is unavailable',
        'Select a signed-in account and a project folder before enabling the local relay.',
      );
      return;
    }
    try {
      const grant = grantBrowserChatWorkspace({
        accountId,
        projectId,
        root: projectRoot,
        displayName: basename(projectRoot),
      });
      setBridgeWorkspaceGrant({
        id: grant.id,
        root: grant.canonicalRoot,
        displayName: grant.displayName,
      });
      toast.success(
        'Read-only project approved',
        'The local relay can read this project for this app session. Writes and terminal access remain blocked.',
      );
    } catch (cause) {
      toast.error(
        'Project access was denied',
        cause instanceof Error ? cause.message : 'This project cannot be granted.',
      );
    }
  };

  const revokeProjectRead = () => {
    revokeBrowserChatWorkspace();
    setBridgeWorkspaceGrant();
    toast.success('Project access revoked', 'The local relay no longer exposes project tools.');
  };

  const connectVibeSpaceMcp = async () => {
    if (!mcpUrl) {
      toast.error(
        'VibeSpace MCP is not configured',
        'This build does not have a verified public VibeSpace MCP endpoint.',
      );
      return;
    }
    try {
      await navigator.clipboard.writeText(mcpUrl);
      await browserChatSurface.openSystemBrowser(provider);
      toast.success(
        'VibeSpace MCP endpoint copied',
        'In ChatGPT Settings → Apps, add VibeSpace MCP and complete the one-time OAuth approval.',
      );
    } catch {
      toast.error(
        'Could not start VibeSpace MCP setup',
        'Copying the endpoint or opening ChatGPT was unavailable.',
      );
    }
  };

  return (
    <section
      aria-label="Browser Chat hub"
      data-vibespace-page="browser-chat"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="flex min-h-16 flex-wrap items-center gap-3 border-b border-border bg-panel/95 px-4 py-3">
        <div className="flex min-w-52 items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-xl border border-accent-copper/25 bg-accent-copper/10 text-accent-copper">
            <Globe2 className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <h1 className="text-sm font-semibold text-foreground">Browser Chat</h1>
            <p className="text-[11px] text-muted-foreground">
              Real provider pages. Your subscriptions. VibeSpace organization.
            </p>
          </div>
        </div>

        <div
          role="tablist"
          aria-label="Browser Chat providers"
          className="flex min-w-0 flex-1 items-center justify-center gap-1"
        >
          {BROWSER_CHAT_PROVIDERS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={option.id === providerId}
              aria-disabled={option.availability === 'future'}
              disabled={option.availability === 'future'}
              onClick={() => setProvider(option.id, chatId)}
              className={cn(
                'min-h-9 rounded-lg border px-4 text-xs font-medium transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-copper/50',
                option.id === providerId
                  ? 'border-accent-copper/45 bg-accent-copper/12 text-foreground'
                  : 'border-transparent text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground',
                option.availability === 'future' && 'cursor-not-allowed opacity-50',
              )}
            >
              {option.label}
              {option.availability === 'future' ? (
                <span className="ml-1.5 text-[9px] uppercase tracking-wide">Future</span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Badge variant={pageStatus === 'ready' ? 'success' : 'secondary'}>
            Page · {statusLabel(pageStatus)}
          </Badge>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void browserChatSurface.openSystemBrowser(provider)}
          >
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            {provider.id === 'chatgpt' ? 'Sign in or sign up' : 'System browser'}
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[13rem_minmax(22rem,1fr)_17rem] gap-3 p-3 max-[1050px]:grid-cols-[11rem_minmax(20rem,1fr)]">
        <aside
          aria-label="Browser Chat local sessions"
          className="flex min-h-0 flex-col rounded-xl border border-border bg-panel/70 p-2.5"
        >
          <div className="flex items-center justify-between px-1">
            <div>
              <h2 className="text-xs font-semibold text-foreground">Provider sessions</h2>
              <p className="text-[10px] text-muted-foreground">Saved per VibeSpace chat</p>
            </div>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="New provider chat"
              onClick={() => void createBrowserChat()}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-auto">
            {sessions?.length ? (
              sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => setActiveChat(session.id)}
                  className={cn(
                    'w-full rounded-lg border px-2.5 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-copper/50',
                    session.id === chatId
                      ? 'border-accent-copper/35 bg-accent-copper/10'
                      : 'border-transparent hover:border-border hover:bg-muted/45',
                  )}
                >
                  <span className="block truncate text-[11px] font-medium text-foreground">
                    {session.title}
                  </span>
                  <span className="mt-0.5 block text-[9px] text-muted-foreground">ChatGPT</span>
                </button>
              ))
            ) : (
              <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center">
                <p className="text-[11px] font-medium text-foreground">ChatGPT home</p>
                <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                  Create a Browser Chat to keep its mode separate from native chats.
                </p>
              </div>
            )}
          </div>
          <div className="mt-auto space-y-2 border-t border-border/70 px-1 pt-3">
            <div className="flex items-start gap-2 text-[10px] leading-4 text-muted-foreground">
              <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-copper" />
              Cookies stay in this provider’s isolated local profile.
            </div>
            <div className="flex items-start gap-2 text-[10px] leading-4 text-muted-foreground">
              <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-copper" />
              Google and other external sign-in opens in your OS default browser. Its cookies are
              never copied into VibeSpace.
            </div>
          </div>
        </aside>

        <BrowserProviderSurface key={provider.id} provider={provider} />

        <aside
          aria-label="Browser Chat connection inspector"
          className="min-h-0 overflow-auto rounded-xl border border-border bg-panel/70 p-3 max-[1050px]:col-span-2"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-foreground">Connection</h2>
          </div>

          <dl className="mt-3 space-y-3 text-[11px]">
            <div className="rounded-lg border border-border bg-background/55 p-2.5">
              <dt className="flex items-center gap-2 font-medium text-foreground">
                <MonitorUp className="h-3.5 w-3.5 text-accent-copper" />
                Page status
              </dt>
              <dd className="mt-1 capitalize text-muted-foreground">{statusLabel(pageStatus)}</dd>
            </div>
            <div className="rounded-lg border border-border bg-background/55 p-2.5">
              <dt className="flex items-center gap-2 font-medium text-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-accent-copper" />
                Tool bridge
              </dt>
              <dd className="mt-1 capitalize text-muted-foreground">{statusLabel(bridgeStatus)}</dd>
              <dd className="mt-1 text-[10px] leading-4 text-muted-foreground">
                The provider page has no direct device authority. The official VibeSpace MCP app can
                use only the project you approve below.
              </dd>
              <dd className="mt-1 text-[10px] leading-4 text-muted-foreground">
                It is not auto-connected by page login. Approve a project, configure the public
                VibeSpace MCP endpoint, then enable VibeSpace MCP in ChatGPT Settings → Apps.
              </dd>
              <dd className="mt-2 rounded-md border border-border/70 bg-muted/25 p-2">
                <span className="flex items-center justify-between gap-2">
                  <strong className="text-[11px] text-foreground">VibeSpace MCP</strong>
                  <Badge variant={relayStatus === 'connected' ? 'success' : 'secondary'}>
                    {relayStatus === 'connected' ? 'Desktop connected' : 'Setup required'}
                  </Badge>
                </span>
                <span className="mt-2 grid gap-1 text-[9px] leading-4 text-muted-foreground">
                  <span className="flex justify-between gap-2">
                    <span>File reads</span>
                    <span>{activeWorkspaceGrant ? 'Available' : 'Project grant required'}</span>
                  </span>
                  <span className="flex justify-between gap-2">
                    <span>File writes</span>
                    <span>Approval required</span>
                  </span>
                  <span className="flex justify-between gap-2">
                    <span>Playwright browser</span>
                    <span>Approval required</span>
                  </span>
                  <span className="flex justify-between gap-2">
                    <span>Terminal commands</span>
                    <span>Approval required</span>
                  </span>
                  <span className="flex justify-between gap-2">
                    <span>Installed MCP tools</span>
                    <span>Approval required</span>
                  </span>
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2 w-full"
                  disabled={!mcpUrl}
                  onClick={() => void connectVibeSpaceMcp()}
                >
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  Connect VibeSpace MCP
                </Button>
                <span className="mt-1 block text-[9px] leading-4 text-muted-foreground">
                  ChatGPT requires one-time OAuth approval. Later desktop relay reconnects are
                  automatic while this session grant is active.
                </span>
              </dd>
              <dd className="mt-2 space-y-1">
                {enabledConnections.length ? (
                  enabledConnections.slice(0, 8).map((connection) => (
                    <span
                      key={connection.pluginId}
                      className="flex items-center justify-between rounded-md bg-muted/45 px-2 py-1"
                    >
                      <span className="truncate">{connection.pluginId}</span>
                      <span className="ml-2 inline-flex items-center gap-1 capitalize text-muted-foreground">
                        {connection.state === 'connecting' ? (
                          <span
                            className="inline-flex gap-0.5 motion-safe:animate-pulse"
                            aria-hidden
                          >
                            <i>·</i>
                            <i>·</i>
                            <i>·</i>
                          </span>
                        ) : null}
                        {statusLabel(connection.state)}
                      </span>
                    </span>
                  ))
                ) : (
                  <span className="text-[10px] text-muted-foreground">
                    No enabled VibeSpace MCP or app connections.
                  </span>
                )}
              </dd>
            </div>
            <div className="rounded-lg border border-border bg-background/55 p-2.5">
              <dt className="flex items-center gap-2 font-medium text-foreground">
                <FolderKey className="h-3.5 w-3.5 text-accent-copper" />
                Local project grant
              </dt>
              <dd className="mt-1 text-[10px] leading-4 text-muted-foreground">
                {activeWorkspaceGrant
                  ? `Local relay armed · ${activeWorkspaceGrant.displayName} · read-only`
                  : projectRoot
                    ? `${basename(projectRoot)} is available but not exposed.`
                    : 'Choose a project folder in Files before enabling local reads.'}
              </dd>
              <dd className="mt-2">
                {activeWorkspaceGrant ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={revokeProjectRead}
                  >
                    Revoke project access
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="w-full"
                    disabled={!projectRoot || !accountId || !projectId}
                    onClick={approveProjectRead}
                  >
                    Approve current project read-only
                  </Button>
                )}
              </dd>
              <dd className="mt-2 text-[9px] leading-4 text-muted-foreground">
                Session-only. Absolute paths are never sent to ChatGPT or stored by the relay.
              </dd>
            </div>
            <div className="rounded-lg border border-border bg-background/55 p-2.5">
              <dt className="flex items-center gap-2 font-medium text-foreground">
                <Bot className="h-3.5 w-3.5 text-accent-copper" />
                Agent &amp; project context
              </dt>
              <dd className="mt-2 space-y-2">
                <select
                  aria-label="Browser Chat agent"
                  value={selectedAgent?.id ?? ''}
                  onChange={(event) => setSelectedAgentId(event.currentTarget.value)}
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-[11px] text-foreground"
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-full justify-start"
                  disabled={!agentPrompt}
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(agentPrompt)
                      .then(() =>
                        toast.success(
                          'Agent prompt copied',
                          'Paste it into ChatGPT. It includes the selected agent, project instructions, and current Context Map.',
                        ),
                      )
                      .catch(() =>
                        toast.error(
                          'Could not copy agent prompt',
                          'Clipboard access is unavailable.',
                        ),
                      );
                  }}
                >
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  Copy agent + Context prompt
                </Button>
                <p className="text-[10px] leading-4 text-muted-foreground">
                  Prepared locally and sent only when you paste it into ChatGPT. Direct VibeSpace
                  tools and approvals remain inside VibeSpace.
                </p>
              </dd>
            </div>
            <div className="rounded-lg border border-border bg-background/55 p-2.5">
              <dt className="flex items-center gap-2 font-medium text-foreground">
                <Bot className="h-3.5 w-3.5 text-accent-copper" />
                Model
              </dt>
              <dd className="mt-1 text-muted-foreground">
                Choose the model in ChatGPT’s own model selector.
              </dd>
            </div>
            <div className="rounded-lg border border-border bg-background/55 p-2.5">
              <dt className="flex items-center gap-2 font-medium text-foreground">
                <Activity className="h-3.5 w-3.5 text-accent-copper" />
                OpenAI usage
              </dt>
              <dd className="mt-1 text-muted-foreground">
                {usageText(
                  openAiUsage?.usageValue ?? null,
                  openAiUsage?.usageLimit ?? null,
                  openAiUsage?.usageUnit ?? null,
                )}
              </dd>
              {openAiUsage?.usagePercent !== null && openAiUsage?.usagePercent !== undefined ? (
                <dd className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-accent-copper transition-[width]"
                    style={{ width: `${Math.min(100, openAiUsage.usagePercent)}%` }}
                  />
                </dd>
              ) : null}
            </div>
            <div className="rounded-lg border border-border bg-background/55 p-2.5">
              <dt className="flex items-center justify-between gap-2 font-medium text-foreground">
                <span className="flex items-center gap-2">
                  <FileUp className="h-3.5 w-3.5 text-accent-copper" />
                  Files and outputs
                </span>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Stage files for Browser Chat"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!chatId}
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </dt>
              <input
                ref={fileInputRef}
                className="sr-only"
                type="file"
                multiple
                onChange={(event) => {
                  stageFiles(event.currentTarget.files);
                  event.currentTarget.value = '';
                }}
              />
              <dd className="mt-1 text-[10px] leading-4 text-muted-foreground">
                Stage files here, then drag them into ChatGPT or use ChatGPT’s attachment control.
              </dd>
              <dd className="mt-2 space-y-1">
                {stagedFiles.map((file) => (
                  <span
                    key={`${file.name}:${file.size}:${file.lastModified}`}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'copy';
                      event.dataTransfer.items.add(file);
                    }}
                    className="flex cursor-grab items-center gap-1.5 rounded-md bg-muted/45 px-2 py-1 text-[10px]"
                  >
                    <Download className="h-3 w-3 shrink-0 text-accent-copper" />
                    <span className="truncate">{file.name}</span>
                  </span>
                ))}
                {!stagedFiles.length ? (
                  <span className="text-[10px] text-muted-foreground">No files staged.</span>
                ) : null}
              </dd>
            </div>
          </dl>

          <div className="mt-4 space-y-2 border-t border-border/70 pt-3 text-[10px] leading-4 text-muted-foreground">
            <p>{provider.serviceSummary}</p>
            <p className="font-medium text-foreground">
              Your provider subscription and limits still apply.
            </p>
            <p>
              VibeSpace does not resell this subscription, read provider messages, or turn a web
              subscription into an unofficial API.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
