import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import type { ChatId } from '@/types';
import { getActiveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';
import { useAgentStore } from '@/stores/agents';
import { useUIStore } from '@/stores/ui';
import { useAccessibleChatModels, type ModelPickerOption } from '@/lib/ai/useAccessibleChatModels';
import { loadPersistedContextMaps } from '@/features/context/contextPersistence';
import type { ContextMapRecord } from '@/features/context/tree';
import { Button } from '@/components/ui/button';
import { captureCouncilContext, councilRunKey, councilWorkflow } from './workflowProduction';
import type { CouncilRoute, CouncilRun, CouncilResult } from './workflow';
import './council.sakura.css';

const fieldClass =
  'rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground';

export function CouncilWorkflowPage({ chatId }: { chatId: string | null }) {
  useAuthStore((s) => s.localUserId);
  useAuthStore((s) => s.cloudSession);
  const accountId = getActiveAccountIdentity()?.accountId ?? '';
  const { flatOptions } = useAccessibleChatModels();
  const agents = useAgentStore((s) => s.agents);
  const roster = Object.values(agents);
  const options = useMemo(
    () =>
      flatOptions.filter(
        (option) =>
          option.available !== false &&
          ['openai-codex', 'opencode-cli'].includes(
            option.connectionId ?? option.connection?.id ?? '',
          ),
      ),
    [flatOptions],
  );
  const chat = useLiveQuery(() => (chatId ? db.chats.get(chatId as ChatId) : undefined), [chatId]);
  const run = useLiveQuery(
    async () =>
      accountId && chatId
        ? ((await db.settings.get(councilRunKey(accountId, chatId)))?.value as
            CouncilRun | undefined)
        : undefined,
    [accountId, chatId],
  );
  const [maps, setMaps] = useState<readonly ContextMapRecord[]>([]);
  const [mapId, setMapId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [selected, setSelected] = useState(['', '']);
  const [agentIds, setAgentIds] = useState(['', '']);
  const [efforts, setEfforts] = useState(['high', 'high']);
  const [synthesisId, setSynthesisId] = useState('');
  const [synthesisEffort, setSynthesisEffort] = useState('high');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    setMaps([]);
    setMapId('');
    setPrompt('');
    setError('');
    if (chat?.project_id)
      void loadPersistedContextMaps(chat.project_id)
        .then((value) => {
          if (!disposed) setMaps(value.filter((map) => map.status === 'active'));
        })
        .catch(() => {
          if (!disposed) setError('Context Maps could not be loaded.');
        });
    return () => {
      disposed = true;
    };
  }, [chat?.project_id, chatId, accountId]);
  useEffect(() => {
    if (run && ['queued', 'running'].includes(run.status) && !councilWorkflow.isActive(run.id))
      void councilWorkflow
        .recover(run)
        .catch(() => setError('Council recovery could not be saved.'));
  }, [run?.id, run?.status]);

  const running = busy || (!!run && ['queued', 'running'].includes(run.status));
  const ready =
    !running &&
    !!chat?.project_id &&
    !!accountId &&
    !!prompt.trim() &&
    !!mapId &&
    selected.every((id) => options.some((option) => option.id === id)) &&
    !!synthesisId &&
    agentIds.every((id) => roster.some((agent) => agent.id === id)) &&
    agentIds[0] !== agentIds[1];
  function route(id: string, effort: string): CouncilRoute {
    const option = options.find((option) => option.id === id);
    if (!option) throw new Error('The selected model route is unavailable.');
    const connectionId = option.connectionId ?? option.connection!.id;
    return {
      backend: connectionId === 'openai-codex' ? 'codex' : 'opencode',
      providerId: option.provider,
      connectionId,
      modelId: option.modelId,
      effort,
    };
  }
  async function start() {
    if (!ready || !chat?.project_id || !chatId) return;
    setBusy(true);
    setError('');
    try {
      const context = await captureCouncilContext(chat.project_id, mapId);
      await councilWorkflow.run({
        id: `council-${crypto.randomUUID()}`,
        accountId,
        workspaceId: chat.workspace_id,
        projectId: chat.project_id,
        chatId,
        prompt: prompt.trim(),
        context,
        perspectives: selected.map((id, index) => {
          const agent = roster.find((agent) => agent.id === agentIds[index]);
          if (!agent) throw new Error('Selected perspective is unavailable.');
          return {
            id: `perspective-${index + 1}`,
            name: agent.name,
            instruction: agent.system_prompt,
            route: route(id, efforts[index]!),
          };
        }),
        synthesisRoute: route(synthesisId, synthesisEffort),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Council could not complete.');
    } finally {
      setBusy(false);
    }
  }
  const modelSelect = (label: string, value: string, onChange: (value: string) => void) => (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <select
        className={fieldClass}
        aria-label={label}
        value={value}
        disabled={running}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Choose an exact route</option>
        {options.map((option: ModelPickerOption) => (
          <option key={option.id} value={option.id}>
            {option.label} · {option.connectionId ?? option.connection?.id}
          </option>
        ))}
      </select>
    </label>
  );
  const effortSelect = (label: string, value: string, onChange: (value: string) => void) => (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <select
        className={fieldClass}
        aria-label={label}
        value={value}
        disabled={running}
        onChange={(e) => onChange(e.target.value)}
      >
        {['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((effort) => (
          <option key={effort}>{effort}</option>
        ))}
      </select>
    </label>
  );
  const resultPanel = (result: CouncilResult) => (
    <section key={result.id} className="rounded-md border border-border bg-panel p-3 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">{result.name}</h3>
        <span role="status">{result.status}</span>
        {['queued', 'running'].includes(result.status) && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => councilWorkflow.cancel(run!.id, result.id)}
          >
            Cancel {result.name}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground break-all">
        {result.route.backend} · {result.route.connectionId} · {result.route.providerId}/
        {result.route.modelId} · {result.route.effort}
      </p>
      <p className="whitespace-pre-wrap text-sm mt-3">{result.text}</p>
      {result.error && (
        <p role="alert" className="text-sm text-destructive">
          {result.error}
        </p>
      )}
      {result.receipt && (
        <p className="text-xs text-muted-foreground mt-2">
          Verified request: {result.receipt.requestId}
        </p>
      )}
    </section>
  );
  return (
    <div
      className="sakura-council-root flex flex-col h-full min-h-0"
      data-vibespace-owned-chrome="council"
    >
      <header className="sakura-council-header flex items-center justify-between p-3 border-b border-border">
        <h2 className="font-medium">Council</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => useUIStore.getState().setChatMode('chat')}
        >
          Back to chat
        </Button>
      </header>
      <div className="flex-1 overflow-auto p-4 space-y-4">
        <p className="text-sm text-muted-foreground">
          Two perspectives, one selected Context Map, and a final Critic synthesis. Model routes
          remain fixed for each run.
        </p>
        <label className="flex flex-col gap-1 text-sm">
          Council request
          <textarea
            aria-label="Council request"
            className={fieldClass}
            value={prompt}
            disabled={running}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={32000}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Context Map
          <select
            aria-label="Context Map"
            className={fieldClass}
            value={mapId}
            disabled={running}
            onChange={(e) => setMapId(e.target.value)}
          >
            <option value="">Choose a Context Map</option>
            {maps.map((map) => (
              <option key={map.id} value={map.id}>
                {map.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {selected.map((value, index) => (
            <div key={index} className="space-y-2 rounded-md border border-border p-3">
              <label className="flex flex-col gap-1 text-sm">
                Perspective {index + 1}
                <select
                  aria-label={`Perspective ${index + 1} agent`}
                  className={fieldClass}
                  disabled={running}
                  value={agentIds[index]}
                  onChange={(e) =>
                    setAgentIds((ids) => ids.map((id, i) => (i === index ? e.target.value : id)))
                  }
                >
                  <option value="">Choose an agent</option>
                  {roster.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </label>
              {modelSelect(`Perspective ${index + 1} model route`, value, (next) =>
                setSelected((values) => values.map((value, i) => (i === index ? next : value))),
              )}
              {effortSelect(`Perspective ${index + 1} effort`, efforts[index]!, (next) =>
                setEfforts((values) => values.map((value, i) => (i === index ? next : value))),
              )}
            </div>
          ))}
        </div>
        {modelSelect('Critic synthesis model route', synthesisId, setSynthesisId)}
        {effortSelect('Critic synthesis effort', synthesisEffort, setSynthesisEffort)}
        <Button disabled={!ready} onClick={() => void start()}>
          Run Council
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {run && (
          <div className="space-y-3">
            <p role="status">
              Council: {run.status} · Context Map {run.context.mapId} · revision{' '}
              {run.context.updatedAt}
            </p>
            <p className="text-sm whitespace-pre-wrap">{run.prompt}</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {run.perspectives.map(resultPanel)}
            </div>
            {run.synthesis && resultPanel(run.synthesis)}
          </div>
        )}
      </div>
    </div>
  );
}
