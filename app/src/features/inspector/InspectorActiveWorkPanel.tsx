import * as React from 'react';
import {
  Activity,
  Bot,
  FileText,
  MessageSquare,
  Pin,
  Terminal as TerminalIcon,
  Boxes,
} from 'lucide-react';
import { cn, formatRelative } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import type { WorkspaceId } from '@/types/common';
import {
  focusChat,
  focusTerminalSession,
  useLiveChatStatuses,
  useLiveTerminalStatuses,
} from './liveWork';
import { useWorkspaceAnalyticsStore, formatDurationMs } from './workspaceAnalytics';
import { usePinnedStore } from './pinnedStore';

interface InspectorActiveWorkPanelProps {
  workspaceId: WorkspaceId | null;
}

export function InspectorActiveWorkPanel({ workspaceId }: InspectorActiveWorkPanelProps) {
  const projectId = useAuthStore((s) => s.projectId);
  const terminals = useLiveTerminalStatuses(workspaceId, projectId);
  const chats = useLiveChatStatuses(workspaceId, projectId);
  const totalTokens = useWorkspaceAnalyticsStore((s) => s.totalTokens);
  const estimatedTotalCostUsd = useWorkspaceAnalyticsStore((s) => s.estimatedTotalCostUsd);
  const foregroundActiveMs = useWorkspaceAnalyticsStore((s) => s.foregroundActiveMs);
  const backgroundRunningMs = useWorkspaceAnalyticsStore((s) => s.backgroundRunningMs);
  const completedMilestones = useWorkspaceAnalyticsStore((s) => s.completedMilestones);
  const toolRunCount = useWorkspaceAnalyticsStore((s) => s.toolRunCount);
  const byModel = useWorkspaceAnalyticsStore((s) => s.byModel);
  const pinnedFiles = usePinnedStore((s) => s.files);
  const pinnedMaps = usePinnedStore((s) => s.maps);
  const unpinFile = usePinnedStore((s) => s.unpinFile);
  const unpinMap = usePinnedStore((s) => s.unpinMap);

  return (
    <div className="flex flex-col gap-4">
      <Section label="Live terminals" icon={<TerminalIcon className="h-3.5 w-3.5" />} hint={String(terminals.length)}>
        {terminals.length === 0 ? (
          <Empty text="No active terminals in this project." />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {terminals.map((t) => (
              <li key={t.sessionId}>
                <WorkCard
                  title={t.terminalName}
                  subtitle={t.lastActivitySummary ?? t.agentName ?? 'PTY session'}
                  status={t.status}
                  meta={formatRelative(t.lastOutputAt ?? Date.now())}
                  icon={<TerminalIcon className="h-3.5 w-3.5" />}
                  onClick={() => focusTerminalSession(t.sessionId, t.paneId)}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section label="Active chats" icon={<MessageSquare className="h-3.5 w-3.5" />} hint={String(chats.length)}>
        {chats.length === 0 ? (
          <Empty text="No recent chats in this project." />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {chats.map((c) => (
              <li key={c.chatId}>
                <WorkCard
                  title={c.title}
                  subtitle={c.lastMessagePreview ?? 'Chat thread'}
                  status={c.status}
                  meta={c.lastActivityAt ? formatRelative(c.lastActivityAt) : ''}
                  icon={<Bot className="h-3.5 w-3.5" />}
                  onClick={() => focusChat(c.chatId)}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section label="Analytics" icon={<Activity className="h-3.5 w-3.5" />}>
        <div className="rounded-md border border-border bg-elevated px-2.5 py-2 text-secondary space-y-1.5">
          <Row label="Tokens (local)" value={totalTokens > 0 ? totalTokens.toLocaleString() : 'Not tracked yet'} />
          <Row
            label="Est. cost"
            value={estimatedTotalCostUsd > 0 ? `$${estimatedTotalCostUsd.toFixed(4)}` : 'Estimated when usage exists'}
          />
          <Row label="Foreground" value={formatDurationMs(foregroundActiveMs)} />
          <Row label="Background" value={formatDurationMs(backgroundRunningMs)} />
          <Row label="Milestones done" value={String(completedMilestones)} />
          <Row label="Tool runs" value={String(toolRunCount)} />
          {byModel.length > 0 ? (
            <div className="pt-1 border-t border-border/60">
              <p className="text-metadata uppercase tracking-wide text-muted-foreground mb-1">By provider</p>
              {byModel.slice(0, 4).map((row) => (
                <Row
                  key={row.providerName}
                  label={row.providerName}
                  value={`${row.totalTokens.toLocaleString()} tok`}
                />
              ))}
            </div>
          ) : null}
        </div>
      </Section>

      <Section label="Pinned files" icon={<Pin className="h-3.5 w-3.5" />} hint={String(pinnedFiles.length)}>
        {pinnedFiles.length === 0 ? (
          <Empty text="Pin files from Context Files via right-click." />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {pinnedFiles.map((file) => (
              <li key={file.path}>
                <PinnedRow
                  title={file.title}
                  path={file.path}
                  icon={<FileText className="h-3.5 w-3.5" />}
                  onUnpin={() => unpinFile(file.path)}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section label="Pinned context maps" icon={<Boxes className="h-3.5 w-3.5" />} hint={String(pinnedMaps.length)}>
        {pinnedMaps.length === 0 ? (
          <Empty text="Pin a context map from Context Files." />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {pinnedMaps.map((map) => (
              <li key={map.id}>
                <PinnedRow
                  title={map.title}
                  path={map.rootDir}
                  icon={<Boxes className="h-3.5 w-3.5" />}
                  onUnpin={() => unpinMap(map.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({
  label,
  icon,
  hint,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-2 px-0.5">
        <span className="inline-flex items-center gap-1.5 text-metadata uppercase tracking-wide text-muted-foreground">
          <span className="text-accent-copper">{icon}</span>
          {label}
        </span>
        {hint ? <span className="text-metadata text-muted-foreground tabular-nums">{hint}</span> : null}
      </header>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-secondary text-muted-foreground italic px-0.5">{text}</p>;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-metadata">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground tabular-nums">{value}</span>
    </div>
  );
}

function WorkCard({
  title,
  subtitle,
  status,
  meta,
  icon,
  onClick,
}: {
  title: string;
  subtitle: string;
  status: 'working' | 'stationary';
  meta: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md border border-border bg-elevated px-2.5 py-2 text-left transition-colors',
        'hover:border-accent-copper/40 hover:bg-paper',
      )}
    >
      <span className="mt-0.5 shrink-0 text-accent-copper">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-secondary text-foreground">{title}</span>
          <StatusPill status={status} />
        </span>
        <span className="block truncate text-metadata text-muted-foreground">{subtitle}</span>
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">{meta}</span>
    </button>
  );
}

function StatusPill({ status }: { status: 'working' | 'stationary' }) {
  const working = status === 'working';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wide',
        working ? 'bg-accent-cyan/15 text-accent-cyan' : 'bg-muted text-muted-foreground',
      )}
    >
      {working ? (
        <span className="h-1.5 w-1.5 rounded-full bg-accent-cyan animate-pulse" aria-hidden />
      ) : null}
      {working ? 'Working' : 'Stationary'}
    </span>
  );
}

function PinnedRow({
  title,
  path,
  icon,
  onUnpin,
}: {
  title: string;
  path: string;
  icon: React.ReactNode;
  onUnpin: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('application/x-jarvis-file', path);
        e.dataTransfer.setData('text/plain', path);
      }}
      className="flex items-center gap-2 rounded-md border border-border bg-elevated px-2.5 py-2"
    >
      <span className="shrink-0 text-accent-copper">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-secondary text-foreground">{title}</p>
        <p className="truncate font-mono text-[10px] text-muted-foreground">{path}</p>
      </div>
      <button
        type="button"
        onClick={onUnpin}
        className="text-[10px] text-muted-foreground hover:text-foreground"
      >
        Unpin
      </button>
    </div>
  );
}
