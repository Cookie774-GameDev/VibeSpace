import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import { WarmHexProgress } from '@/components/progress/WarmHexProgress';
import { Button } from '@/components/ui/button';
import type { ChatId } from '@/types';
import type { CaoMission } from './mission/types';
import { CaoDeskScene } from './CaoDeskScene';

export function CaoMissionOverview({
  mission,
  onApprove,
  busy,
}: {
  mission: CaoMission;
  onApprove?: (targetId: string, proposalId: string) => void;
  busy: boolean;
}) {
  const data = useLiveQuery(async () => {
    const ids = mission.workers
      .filter((worker) => worker.kind === 'chat')
      .map((worker) => worker.targetId as ChatId);
    const chats = ids.length
      ? (await db.chats.bulkGet(ids)).filter(
          (chat) =>
            chat &&
            String(chat.workspace_id) === mission.workspaceId &&
            String(chat.project_id ?? '') === (mission.projectId ?? ''),
        )
      : [];
    const validIds = chats.flatMap((chat) => (chat ? [chat.id] : []));
    const messages = validIds.length
      ? await db.messages
          .where('chat_id')
          .anyOf(validIds)
          .filter(
            (message) =>
              message.created_at >= mission.createdAt &&
              message.created_at <=
                (['completed', 'failed', 'cancelled'].includes(mission.status)
                  ? mission.updatedAt
                  : Infinity),
          )
          .toArray()
      : [];
    const jev = (await db.jev_usage_records.toArray()).filter(
      (row) =>
        row.missionId === mission.id &&
        row.accountId === mission.accountId &&
        row.workspaceId === mission.workspaceId &&
        row.projectId === mission.projectId,
    );
    return { chats, messages, jev };
  }, [mission.id, mission.updatedAt, mission.status]);
  const done = mission.workers.filter((worker) => worker.status === 'done').length;
  const progress = mission.workers.length ? (100 * done) / mission.workers.length : null;
  const usages =
    data?.messages.flatMap((message) =>
      message.usage && message.usage.provenance !== 'unavailable' ? [message.usage] : [],
    ) ?? [];
  const tokenValues = usages.flatMap((usage) =>
    typeof usage.total_tokens === 'number'
      ? [usage.total_tokens]
      : typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number'
        ? [usage.input_tokens + usage.output_tokens]
        : [],
  );
  const costs = usages.flatMap((usage) =>
    typeof usage.cost_usd === 'number' ? [usage.cost_usd] : [],
  );
  const models = [...new Set(mission.workers.map((worker) => worker.modelId).filter(Boolean))];
  return (
    <div className="space-y-5" aria-label="CAO live overview">
      <CaoDeskScene mission={mission} />
      <div className="flex items-center justify-between gap-3 text-xs">
        <span role="status" className="rounded-full bg-muted px-3 py-1 font-semibold capitalize">
          {mission.status}
        </span>
        <span className="text-muted-foreground">
          Updated {new Date(mission.updatedAt).toLocaleTimeString()}
        </span>
      </div>
      <p className="text-sm whitespace-pre-wrap">{mission.objective}</p>
      <WarmHexProgress
        progress={progress}
        label={`${done} of ${mission.workers.length} workers completed`}
        detail="Progress follows recorded worker completion, not an estimate of remaining time."
        mode="compact"
        paused={mission.status === 'cancelled'}
      />
      <dl className="cao-metrics">
        <div>
          <dt>Chats</dt>
          <dd>{mission.workers.filter((worker) => worker.kind === 'chat').length}</dd>
        </div>
        <div>
          <dt>Chat tokens since start</dt>
          <dd>
            {tokenValues.length
              ? tokenValues.reduce((sum, n) => sum + n, 0).toLocaleString()
              : 'Not reported'}
          </dd>
        </div>
        <div>
          <dt>Reported chat cost</dt>
          <dd>
            {costs.length ? '$' + costs.reduce((sum, n) => sum + n, 0).toFixed(4) : 'Not reported'}
          </dd>
        </div>
        <div>
          <dt>Terminals</dt>
          <dd>{mission.workers.filter((worker) => worker.kind === 'terminal').length}</dd>
        </div>
        <div>
          <dt>Pinned chats</dt>
          <dd>{data?.chats.filter((chat) => chat?.pinned).length ?? '—'}</dd>
        </div>
        <div>
          <dt>Jev checks</dt>
          <dd>{data?.jev.length ?? '—'}</dd>
        </div>
        <div>
          <dt>Sentinel observations</dt>
          <dd>
            {
              mission.workers.filter(
                (worker) =>
                  Number.isSafeInteger(worker.lastObservedRevision) &&
                  (worker.lastObservedRevision ?? -1) >= 0,
              ).length
            }
            /{mission.workers.length} targets
          </dd>
        </div>
        <div>
          <dt>Worker models</dt>
          <dd>{models.length}</dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">
        Chat usage includes recorded turns in these chats during the mission. Terminal usage and
        subscription balances are not included.{' '}
        {usages.some((usage) => usage.provenance === 'estimated')
          ? 'Includes estimated usage.'
          : ''}
      </p>
      <div className="space-y-2">
        {mission.workers.map((worker) => (
          <article key={`${worker.kind}:${worker.targetId}`} className="cao-target-card">
            <div className="flex justify-between gap-3">
              <strong>
                {data?.chats.find((chat) => chat?.id === worker.targetId)?.title ?? worker.targetId}
              </strong>
              <span className="text-xs">{worker.status}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {worker.kind} · {worker.modelId ?? 'Model not recorded'} · {worker.reasoningEffort}
            </p>
            <p className="mt-2 text-sm whitespace-pre-wrap">{worker.assignment}</p>
            {worker.status === 'waiting' && worker.proposalId && onApprove && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => onApprove(worker.targetId, worker.proposalId!)}
              >
                Approve this assignment
              </Button>
            )}
          </article>
        ))}
      </div>
      {mission.milestones.length > 0 && (
        <ul className="space-y-2 text-sm">
          {mission.milestones.map((item) => (
            <li key={item.id}>
              {item.label} · {item.status}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
