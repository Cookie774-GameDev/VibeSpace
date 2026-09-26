import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Button } from '@/components/ui/button';
import { CaoModelPicker } from './CaoModelPicker';
import { CaoMissionOverview } from './CaoMissionOverview';
import { useCaoSetupDraft, readCaoDraft, caoDraftKey } from './missionDraft';
import { CaoDeskScene } from './CaoDeskScene';
import { JevCredentialCard } from '@/features/settings/components/JevCredentialCard';
import { Target, BrainCircuit, Users, ShieldCheck, ClipboardCheck } from 'lucide-react';
import { db } from '@/lib/db';
import { chatRepo, terminalSessionRepo } from '@/lib/db/repositories';
import { subscribeDiscoveredConnectionModels } from '@/lib/ai/connectionCatalog';
import { refreshAccessibleChatModelCatalog } from '@/lib/ai/useAccessibleChatModels';
import type { Chat } from '@/types/chat';
import type { ProjectId, WorkspaceId } from '@/types/common';
import type { TerminalSession } from '@/types/terminal';
import type { LiveTerminalTarget } from '@/features/instant-command/types';
import {
  loadCaoExecutionProfile,
  persistCaoExecutionProfile,
  selectCaoExecutionProfile,
  type CaoExecutionIdentity,
  type CaoExecutionProfile,
  type CaoLiveExecutionCatalog,
} from './executionProfile';
import { caoDiscoveredModelsSnapshot, readCaoChatTargetIdentity } from './targetIdentity';
import { planCaoMission } from './mission/missionPlanner';
import { caoProductionController, type CaoMissionStartInput } from './mission/productionController';
import type { CaoMission } from './mission/types';
import { readLiveCaoExecutionCatalog } from './productionLifecycle';
import { listCaoTerminals } from './terminalControlProduction';
import {
  getCaoTerminalExecutionIdentityRevision,
  readCaoTerminalExecutionIdentity,
  subscribeCaoTerminalExecutionIdentity,
  type CaoTerminalExecutionBinding,
} from './terminalExecutionIdentity';
import type { CaoControlScope } from './controlCommand';

type CaoLiveTerminalTarget = Pick<
  LiveTerminalTarget,
  'sessionId' | 'paneId' | 'projectId' | 'processIdentity'
>;

type CaoMissionTarget = Readonly<{
  kind: 'chat' | 'terminal';
  targetId: string;
  title: string;
  workspaceId: string;
  projectId: string;
  status: string;
  identity?: CaoExecutionIdentity;
}>;

export type CaoMissionController = Pick<
  typeof caoProductionController,
  'start' | 'cancel' | 'get'
> &
  Partial<Pick<typeof caoProductionController, 'approveAssignment'>>;

type CaoMissionWorkerInput = CaoMissionStartInput['workers'][number];

function targetKey(target: Pick<CaoMissionTarget, 'kind' | 'targetId'>): string {
  return `${target.kind}:${target.targetId}`;
}

function errorText(cause: unknown): string {
  if (cause instanceof Error && cause.message === 'cao_execution_catalog_unavailable') {
    return 'No connected CLI has supplied a verified model list yet. Check the Codex or OpenCode connection in chat, then refresh models. Your mission has not started.';
  }
  if (cause instanceof Error && cause.message === 'cao_mission_scope_unavailable') {
    return 'This workspace or project is no longer available to the current account. Select an accessible project, then reopen CAO. The mission has not started.';
  }
  if (cause instanceof Error && cause.message) return cause.message.replaceAll('_', ' ');
  return 'CAO could not prepare this mission.';
}

function identityMatches(
  profile: CaoExecutionProfile | undefined,
  identity: CaoExecutionIdentity | undefined,
): boolean {
  return Boolean(
    profile &&
    identity &&
    profile.backend === identity.backend &&
    profile.providerId === identity.providerId &&
    profile.connectionId === identity.connectionId &&
    profile.modelId === identity.modelId &&
    profile.reasoningEffort === identity.reasoningEffort,
  );
}

function sameIdentity(left: CaoExecutionIdentity, right: CaoExecutionIdentity): boolean {
  return (
    left.backend === right.backend &&
    left.providerId === right.providerId &&
    left.connectionId === right.connectionId &&
    left.modelId === right.modelId &&
    left.reasoningEffort === right.reasoningEffort
  );
}

export { readCaoChatTargetIdentity };

export function readCaoTerminalTargetIdentity(
  accountId: string,
  projectId: string,
  terminalId: string,
  liveTargets: readonly CaoLiveTerminalTarget[],
): CaoExecutionIdentity | undefined {
  const liveTarget = liveTargets.find(
    (candidate) => candidate.sessionId === terminalId && candidate.projectId === projectId,
  );
  if (!liveTarget) return undefined;
  const binding: CaoTerminalExecutionBinding = {
    accountId,
    projectId,
    paneId: liveTarget.paneId,
    sessionId: liveTarget.sessionId,
    process: liveTarget.processIdentity,
  };
  return readCaoTerminalExecutionIdentity(binding)?.identity;
}

function targetRows(
  chats: readonly Chat[],
  terminals: readonly TerminalSession[],
  liveTerminals: readonly CaoLiveTerminalTarget[],
  scope: CaoControlScope,
): CaoMissionTarget[] {
  if (!scope.projectId) return [];
  const chatTargets = chats
    .filter(
      (chat) =>
        String(chat.workspace_id) === scope.workspaceId &&
        String(chat.project_id ?? '') === scope.projectId,
    )
    .map((chat) => ({
      kind: 'chat' as const,
      targetId: String(chat.id),
      title: chat.title.trim() || String(chat.id),
      workspaceId: String(chat.workspace_id),
      projectId: String(chat.project_id),
      status: chat.archived ? 'archived' : 'ready',
      identity: readCaoChatTargetIdentity(chat),
    }));
  const terminalTargets = terminals
    .filter(
      (terminal) =>
        String(terminal.workspace_id) === scope.workspaceId &&
        String(terminal.project_id ?? '') === scope.projectId,
    )
    .map((terminal) => ({
      kind: 'terminal' as const,
      targetId: String(terminal.id),
      title: terminal.title.trim() || String(terminal.id),
      workspaceId: String(terminal.workspace_id),
      projectId: String(terminal.project_id),
      status: terminal.status,
      identity: readCaoTerminalTargetIdentity(
        scope.accountId,
        scope.projectId,
        String(terminal.id),
        liveTerminals,
      ),
    }));
  return [...chatTargets, ...terminalTargets].sort((left, right) =>
    `${left.kind}:${left.title}`.localeCompare(`${right.kind}:${right.title}`),
  );
}

export function CaoMissionPanel({
  scope,
  callerChatId,
  controller = caoProductionController,
}: Readonly<{
  scope: CaoControlScope;
  callerChatId?: string;
  controller?: CaoMissionController;
}>) {
  const terminalIdentityRevision = useSyncExternalStore(
    subscribeCaoTerminalExecutionIdentity,
    getCaoTerminalExecutionIdentityRevision,
    getCaoTerminalExecutionIdentityRevision,
  );
  const discoveredModelsSnapshot = useSyncExternalStore(
    subscribeDiscoveredConnectionModels,
    caoDiscoveredModelsSnapshot,
    caoDiscoveredModelsSnapshot,
  );
  const targetRevision = `${terminalIdentityRevision}:${discoveredModelsSnapshot}`;
  const targets = useLiveQuery(
    async () => {
      if (!scope.projectId) return [];
      const [chats, terminals, liveTerminals] = await Promise.all([
        chatRepo.listByProject(scope.projectId as ProjectId),
        terminalSessionRepo.listByProject(scope.projectId as ProjectId),
        listCaoTerminals(scope.accountId, scope.projectId).catch(
          () => [] as CaoLiveTerminalTarget[],
        ),
      ]);
      return targetRows(chats, terminals, liveTerminals, scope);
    },
    [scope.accountId, scope.workspaceId, scope.projectId, targetRevision],
    [] as CaoMissionTarget[],
  );
  const missionRows = useLiveQuery(
    async () => db.cao_missions.toArray(),
    [scope.accountId, scope.workspaceId, scope.projectId],
    [],
  );
  const [catalog, setCatalog] = useState<CaoLiveExecutionCatalog>();
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [backend, setBackend] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [modelId, setModelId] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [savedProfile, setSavedProfile] = useState<CaoExecutionProfile>();
  const { draft, update } = useCaoSetupDraft(scope);
  const { objective, step, editing } = draft;
  const selectedTargets = new Set(draft.targets);
  const setObjective = (value: string) => update('objective', value);
  const setStep = (value: React.SetStateAction<number>) => update('step', value);
  const setEditing = (value: boolean) => update('editing', value);
  const setSelectedTargets = (change: (current: ReadonlySet<string>) => ReadonlySet<string>) =>
    update('targets', (current) => [...change(new Set(current))]);
  const [mission, setMission] = useState<CaoMission>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scopeUnavailable, setScopeUnavailable] = useState(false);
  const [notice, setNotice] = useState('');
  const scopeEpoch = useRef(0);
  const previousDiscoveredModelsSnapshot = useRef<string | undefined>(undefined);

  const entries = useMemo(() => catalog?.entries ?? [], [catalog]);
  const selectedIdentity = useMemo<CaoExecutionIdentity | undefined>(() => {
    const entry = entries.find(
      (candidate) =>
        candidate.backend === backend &&
        candidate.connectionId === connectionId &&
        candidate.modelId === modelId &&
        candidate.reasoningEffort === reasoningEffort,
    );
    return entry;
  }, [backend, connectionId, entries, modelId, reasoningEffort]);
  const availableTargets = useMemo(
    () =>
      targets.map((target) => {
        const identity = target.identity;
        const liveIdentity = identity
          ? entries.find((entry) => sameIdentity(entry, identity))
          : undefined;
        return liveIdentity
          ? { ...target, identity: liveIdentity }
          : { ...target, identity: undefined };
      }),
    [entries, targets],
  );
  const selectedTargetRows = availableTargets.filter((target) =>
    selectedTargets.has(targetKey(target)),
  );
  const latestMissionRow = useMemo(() => {
    return missionRows
      .filter(
        (candidate) =>
          candidate.accountId === scope.accountId &&
          candidate.workspaceId === scope.workspaceId &&
          candidate.projectId === scope.projectId,
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  }, [missionRows, scope.accountId, scope.projectId, scope.workspaceId]);
  const latestMissionId = latestMissionRow?.id;
  const latestMissionRevision = latestMissionRow
    ? `${latestMissionRow.id}:${latestMissionRow.updatedAt}:${latestMissionRow.status}`
    : '';
  const profileDirty = !identityMatches(savedProfile, selectedIdentity);

  const setIdentity = (
    identity: CaoExecutionIdentity | undefined,
    options: { explicit?: boolean; profileUpdatedAt?: number | null } = {},
  ) => {
    if (identity) update('choice', identity);
    const explicit = Boolean(identity && options.explicit);
    update('choiceExplicit', explicit);
    update(
      'choiceProfileUpdatedAt',
      explicit ? (options.profileUpdatedAt ?? savedProfile?.updatedAt ?? null) : null,
    );
    setBackend(identity?.backend ?? '');
    setConnectionId(identity?.connectionId ?? '');
    setModelId(identity?.modelId ?? '');
    setReasoningEffort(identity?.reasoningEffort ?? '');
  };

  const refreshCatalog = async (requestedEpoch = scopeEpoch.current, forceDiscovery = false) => {
    const isCurrent = () => requestedEpoch === scopeEpoch.current;
    setCatalogBusy(true);
    setCatalogError('');
    setNotice('');
    try {
      if (forceDiscovery) {
        // Discovery can stall on an external CLI. A verified live catalog read
        // remains authoritative, so do not leave the wizard disabled forever.
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            refreshAccessibleChatModelCatalog(),
            new Promise<void>((resolve) => {
              deadline = setTimeout(resolve, 12_000);
            }),
          ]);
        } finally {
          if (deadline) clearTimeout(deadline);
        }
      }
      const nextCatalog = await readLiveCaoExecutionCatalog({
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
      });
      if (!isCurrent()) return;
      setCatalog(nextCatalog);
      let persisted: CaoExecutionProfile | undefined;
      let profileReadSucceeded = false;
      try {
        persisted = await loadCaoExecutionProfile(db, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
        });
        profileReadSucceeded = true;
      } catch (cause) {
        setCatalogError(errorText(cause));
      }
      if (!isCurrent()) return;
      const persistedEntry = persisted
        ? nextCatalog.entries.find((entry) => identityMatches(persisted, entry))
        : undefined;
      const retainedDraft = readCaoDraft(caoDraftKey(scope));
      const retainedChoiceIsCurrent =
        profileReadSucceeded &&
        retainedDraft.choiceExplicit === true &&
        (retainedDraft.choiceProfileUpdatedAt ?? null) === (persisted?.updatedAt ?? null);
      const retainedChoiceEntry = retainedChoiceIsCurrent
        ? nextCatalog.entries.find(
            (entry) => retainedDraft.choice && sameIdentity(entry, retainedDraft.choice),
          )
        : undefined;
      const initial =
        retainedChoiceEntry ??
        persistedEntry ??
        (profileReadSucceeded && !persisted ? nextCatalog.entries[0] : undefined);
      setIdentity(initial, {
        explicit: Boolean(retainedChoiceEntry),
        profileUpdatedAt: persisted?.updatedAt ?? null,
      });
      setSavedProfile(profileReadSucceeded ? persisted : undefined);
      if (!initial && profileReadSucceeded)
        setCatalogError('No verified live CAO execution route is available.');
    } catch (cause) {
      if (!isCurrent()) return;
      setCatalog(undefined);
      setIdentity(undefined);
      setSavedProfile(undefined);
      setCatalogError(errorText(cause));
    } finally {
      if (isCurrent()) setCatalogBusy(false);
    }
  };

  useEffect(() => {
    const retainedChoice = draft.choice;
    if (
      !retainedChoice ||
      draft.choiceExplicit !== true ||
      (draft.choiceProfileUpdatedAt ?? null) !== (savedProfile?.updatedAt ?? null)
    )
      return;
    setBackend(retainedChoice.backend);
    setConnectionId(retainedChoice.connectionId);
    setModelId(retainedChoice.modelId);
    setReasoningEffort(retainedChoice.reasoningEffort);
  }, [
    draft.choice?.backend,
    draft.choice?.connectionId,
    draft.choice?.modelId,
    draft.choice?.reasoningEffort,
    draft.choiceExplicit,
    draft.choiceProfileUpdatedAt,
    savedProfile?.updatedAt,
  ]);

  useEffect(() => {
    const epoch = ++scopeEpoch.current;
    setMission(undefined);
    setBusy(false);
    setNotice('');
    setError('');
    setScopeUnavailable(false);
    void refreshCatalog(epoch, true);
    // The scope object is intentionally projected to its stable ownership keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.accountId, scope.workspaceId, scope.projectId]);

  useEffect(() => {
    const previous = previousDiscoveredModelsSnapshot.current;
    previousDiscoveredModelsSnapshot.current = discoveredModelsSnapshot;
    if (previous === undefined || previous === discoveredModelsSnapshot) return;
    void refreshCatalog();
    // The snapshot is the external catalog subscription boundary. The scope
    // effect above owns the initial and scope-change refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discoveredModelsSnapshot]);

  useEffect(() => {
    if (!controller || !latestMissionId) {
      if (!latestMissionId) setMission(undefined);
      return;
    }
    const epoch = scopeEpoch.current;
    let active = true;
    void controller
      .get({
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        missionId: latestMissionId,
      })
      .then((next) => {
        if (active && epoch === scopeEpoch.current) setMission(next ?? undefined);
      })
      .catch((cause) => {
        if (active && epoch === scopeEpoch.current) setError(errorText(cause));
      });
    return () => {
      active = false;
    };
  }, [
    controller,
    latestMissionId,
    latestMissionRevision,
    scope.accountId,
    scope.projectId,
    scope.workspaceId,
  ]);

  const saveProfile = async () => {
    if (!catalog || !selectedIdentity) {
      setError('Choose a verified live brain route before saving the profile.');
      return false;
    }
    setBusy(true);
    setError('');
    setNotice('');
    const epoch = scopeEpoch.current;
    try {
      const nextProfile = selectCaoExecutionProfile({
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        catalog,
        modelId: selectedIdentity.modelId,
        reasoningEffort: selectedIdentity.reasoningEffort,
        backend: selectedIdentity.backend,
        connectionId: selectedIdentity.connectionId,
      });
      await persistCaoExecutionProfile(db, nextProfile);
      if (epoch === scopeEpoch.current) {
        setSavedProfile(nextProfile);
        setIdentity(selectedIdentity);
        setNotice('CAO brain profile saved for this account and workspace.');
        return true;
      }
    } catch (cause) {
      if (epoch === scopeEpoch.current) setError(errorText(cause));
    } finally {
      if (epoch === scopeEpoch.current) setBusy(false);
    }
  };

  const restoreLocalProject = async () => {
    if (busy || !scopeUnavailable) return;
    const epoch = scopeEpoch.current;
    setBusy(true);
    setNotice('');
    try {
      const { recoverMissingPersistedLocalScope } =
        await import('@/features/access/workspaceRestore');
      if (epoch !== scopeEpoch.current) return;
      const result = await recoverMissingPersistedLocalScope({
        accountId: scope.accountId,
        workspaceId: scope.workspaceId as WorkspaceId,
        projectId: scope.projectId as ProjectId,
      });
      if (epoch !== scopeEpoch.current) return;
      if (result.status === 'not_recoverable') {
        setError(
          'This project could not be safely recovered. Select an accessible project or restore a workspace backup.',
        );
        return;
      }
      setScopeUnavailable(false);
      setError('');
      setNotice('Local project restored. Review the mission, then select Run mission when ready.');
    } catch (cause) {
      if (epoch === scopeEpoch.current) setError(errorText(cause));
    } finally {
      if (epoch === scopeEpoch.current) setBusy(false);
    }
  };

  const startMission = async () => {
    setScopeUnavailable(false);
    if (!controller) {
      setError('The production CAO mission controller is not connected.');
      return;
    }
    if (!savedProfile || !selectedIdentity || profileDirty) {
      setError('Save the selected live brain profile before starting a mission.');
      return;
    }
    if (!objective.trim()) {
      setError('Enter a mission objective.');
      return;
    }
    if (selectedTargetRows.length === 0) {
      setError('Select at least one existing chat or terminal in this project.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    const aborter = new AbortController();
    const epoch = scopeEpoch.current;
    try {
      const liveTerminalTargets = selectedTargetRows.some((target) => target.kind === 'terminal')
        ? await listCaoTerminals(scope.accountId, scope.projectId)
        : [];
      if (epoch !== scopeEpoch.current) return;

      const workers: CaoMissionWorkerInput[] = [];
      for (const target of selectedTargetRows) {
        const identity =
          target.kind === 'terminal'
            ? readCaoTerminalTargetIdentity(
                scope.accountId,
                scope.projectId ?? '',
                target.targetId,
                liveTerminalTargets,
              )
            : target.identity;
        if (
          !identity ||
          (target.kind === 'terminal' &&
            (!target.identity || !sameIdentity(identity, target.identity)))
        ) {
          setError(
            `${target.title} has no verified current worker route. Refresh the targets first.`,
          );
          return;
        }
        workers.push({
          targetId: target.targetId,
          kind: target.kind,
          assignment: 'Awaiting CAO analysis',
          backend: identity.backend,
          connectionId: identity.connectionId,
          modelId: identity.modelId,
          reasoningEffort: identity.reasoningEffort,
          ownedPaths: [],
        });
      }

      // Validate duplicate targets and overlapping ownership before asking the
      // production controller to persist or launch anything. The controller
      // repeats this validation when it creates the durable mission snapshot.
      planCaoMission({
        missionId: `cao-ui-preview-${Date.now()}`,
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        objective: objective.trim(),
        workers: workers.map((worker) => ({
          targetId: worker.targetId,
          kind: worker.kind,
          backend: worker.backend,
          modelId: worker.modelId,
          reasoningEffort: worker.reasoningEffort,
          assignment: worker.assignment,
          ownedPaths: worker.ownedPaths,
        })),
      });

      const result = await controller.start({
        scope: {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
        },
        objective: objective.trim(),
        workers,
        assignmentMode: 'automatic',
        mainProfile: {
          backend: savedProfile.backend,
          connectionId: savedProfile.connectionId,
          modelId: savedProfile.modelId,
          reasoningEffort: savedProfile.reasoningEffort,
        },
        ...(callerChatId ? { callerChatId } : {}),
        signal: aborter.signal,
      });
      if (epoch === scopeEpoch.current) {
        setMission(result.mission);
        setEditing(false);
        setObjective('');
        setStep(0);
        setSelectedTargets(() => new Set());
        setNotice('Mission started through the CAO production controller.');
      }
    } catch (cause) {
      if (epoch === scopeEpoch.current) {
        setError(errorText(cause));
        setScopeUnavailable(
          cause instanceof Error && cause.message === 'cao_mission_scope_unavailable',
        );
      }
    } finally {
      if (epoch === scopeEpoch.current) setBusy(false);
    }
  };

  const cancelMission = async () => {
    if (!controller || !mission) return;
    setBusy(true);
    setError('');
    setNotice('');
    const epoch = scopeEpoch.current;
    try {
      const cancelled = await controller.cancel({
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        missionId: mission.id,
        reason: 'user_requested',
      });
      if (epoch === scopeEpoch.current) {
        setMission(cancelled);
        setNotice('Mission cancellation was recorded by the CAO controller.');
      }
    } catch (cause) {
      if (epoch === scopeEpoch.current) setError(errorText(cause));
    } finally {
      if (epoch === scopeEpoch.current) setBusy(false);
    }
  };

  const steps = ['Objective', 'Model', 'Team', 'Jev', 'Review'];
  const stepIcons = [Target, BrainCircuit, Users, ShieldCheck, ClipboardCheck];
  const showOverview = Boolean(mission && !editing);
  const persistedFailure =
    showOverview &&
    mission &&
    'failureReason' in mission &&
    typeof mission.failureReason === 'string'
      ? errorText(new Error(mission.failureReason))
      : '';
  const displayedError = error || persistedFailure;
  const activeMission = mission && !['completed', 'failed', 'cancelled'].includes(mission.status);
  const nextStep = async () => {
    setError('');
    if (step === 0 && !objective.trim()) {
      setError('Tell CAO what you want to accomplish.');
      return;
    }
    if (step === 1 && !(await saveProfile())) return;
    if (step === 2) {
      try {
        if (!selectedTargetRows.length) throw new Error('Choose at least one chat or terminal.');
        const workers = selectedTargetRows.map((target) => {
          if (!target.identity) throw new Error(`${target.title} needs a verified live model.`);
          return {
            ...target.identity,
            targetId: target.targetId,
            kind: target.kind,
            assignment: 'Awaiting CAO analysis',
            ownedPaths: [],
          };
        });
        planCaoMission({ missionId: 'preview', ...scope, objective, workers });
      } catch (cause) {
        setError(errorText(cause));
        return;
      }
    }
    setStep((current) => Math.min(steps.length - 1, current + 1));
  };
  const approve = controller?.approveAssignment
    ? async (targetId: string, proposalId: string) => {
        if (!mission) return;
        setBusy(true);
        setError('');
        try {
          await controller.approveAssignment!({
            ...scope,
            missionId: mission.id,
            targetId,
            proposalId,
          });
          setMission((await controller.get({ ...scope, missionId: mission.id })) ?? undefined);
        } catch (cause) {
          setError(errorText(cause));
        } finally {
          setBusy(false);
        }
      }
    : undefined;

  return (
    <section aria-label="CAO mission control" className="cao-controls cao-mission-panel">
      <header className="cao-mission-toolbar">
        <span className="cao-eyebrow cao-signal-label">
          <svg className="cao-signal" viewBox="0 0 48 24" fill="none" aria-hidden="true">
            <path d="M6 12h12m12 0h12M24 6v12" />
            <circle cx="6" cy="12" r="3" />
            <circle className="cao-signal-core" cx="24" cy="12" r="6" />
            <circle cx="42" cy="12" r="3" />
          </svg>
          {showOverview ? 'MISSION CONTROL' : 'BUILD YOUR TEAM'}
        </span>
        <div className="flex items-center gap-2">
          {showOverview && !activeMission && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(true);
                setStep(0);
              }}
            >
              New mission
            </Button>
          )}
          {!showOverview && mission && (
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Live overview
            </Button>
          )}
          {activeMission && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void cancelMission()}
            >
              Cancel mission
            </Button>
          )}
        </div>
      </header>
      <div role="region" aria-label="CAO mission controls" className="cao-mission-body">
        {!scope.projectId ? (
          <p className="cao-target-card">Open a project chat to choose its agents and terminals.</p>
        ) : showOverview && mission ? (
          <CaoMissionOverview
            mission={mission}
            busy={busy}
            onApprove={approve ? (target, proposal) => void approve(target, proposal) : undefined}
          />
        ) : (
          <>
            <ol className="cao-stepper" aria-label="Mission setup steps">
              {steps.map((name, index) => {
                const StepIcon = stepIcons[index]!;
                return (
                  <li
                    key={name}
                    aria-current={step === index ? 'step' : undefined}
                    data-complete={index < step}
                  >
                    <span aria-hidden="true">
                      <StepIcon size={16} strokeWidth={1.7} />
                    </span>
                    {name}
                  </li>
                );
              })}
            </ol>
            <div className="cao-question-heading">
              <span className="cao-eyebrow">
                STEP {step + 1} OF {steps.length}
              </span>
              <h3>
                {
                  [
                    'What should CAO accomplish?',
                    'Who should coordinate the work?',
                    'Which agents are on this mission?',
                    'Who checks the work?',
                    'Ready to put the team to work?',
                  ][step]
                }
              </h3>
              <p>
                {
                  [
                    'Describe the outcome. Your agents keep their existing tools, models, and permissions.',
                    'Use the same live model and effort picker as chat.',
                    'Choose your team. CAO reads their current context and divides the work for you.',
                    'Jev is the existing Sentinel checker. Its connection and model are shared with Settings.',
                    'Review the configuration below. Work starts only when you choose Run mission.',
                  ][step]
                }
              </p>
            </div>
            {step === 0 && (
              <label>
                Mission objective
                <textarea
                  aria-label="CAO mission objective"
                  className="cao-objective"
                  rows={5}
                  maxLength={8000}
                  value={objective}
                  disabled={busy}
                  onChange={(event) => setObjective(event.target.value)}
                  placeholder="What would a successful result look like?"
                />
              </label>
            )}
            <div hidden={step !== 1} className="space-y-4">
              <CaoModelPicker
                label="CAO coordination model"
                value={selectedIdentity}
                effort={reasoningEffort}
                disabled={busy || catalogBusy}
                allow={(option) =>
                  entries.some(
                    (entry) =>
                      entry.modelId === option.modelId &&
                      entry.providerId === option.provider &&
                      entry.connectionId === (option.connectionId ?? option.connection?.id),
                  )
                }
                onSelect={(option, effort) => {
                  const identity = entries.find(
                    (entry) =>
                      entry.modelId === option.modelId &&
                      entry.providerId === option.provider &&
                      entry.connectionId === (option.connectionId ?? option.connection?.id) &&
                      entry.reasoningEffort === effort,
                  );
                  if (identity) {
                    setIdentity(identity, {
                      explicit: true,
                      profileUpdatedAt: savedProfile?.updatedAt ?? null,
                    });
                    setError('');
                  } else
                    setError(
                      'That effort is not available on this live CAO route. Refresh the catalog and select again.',
                    );
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={catalogBusy || busy}
                onClick={() => void refreshCatalog(scopeEpoch.current, true)}
              >
                {catalogBusy ? 'Refreshing…' : 'Refresh models'}
              </Button>
              <p className="text-xs text-muted-foreground">
                {savedProfile && !profileDirty
                  ? 'Your saved coordination model is selected.'
                  : 'Continue to save this coordination model.'}
              </p>
            </div>
            {step === 2 && (
              <div className="space-y-3">
                {(['chat', 'terminal'] as const).map((kind) => {
                  const group = availableTargets.filter(
                    (target) =>
                      target.kind === kind &&
                      (kind === 'chat' || (target.identity && target.status !== 'exited')),
                  );
                  return (
                    <section
                      key={kind}
                      className="space-y-2"
                      aria-label={kind === 'chat' ? 'Chats' : 'Agent terminals'}
                    >
                      <h4 className="cao-eyebrow">
                        {kind === 'chat' ? 'Chats' : 'Agent terminals'}
                      </h4>
                      {!group.length && (
                        <p className="text-xs text-muted-foreground">
                          {kind === 'chat'
                            ? 'No project chats yet.'
                            : 'No connected agent terminals. Empty shells are hidden.'}
                        </p>
                      )}
                      {group.map((target) => (
                        <article className="cao-target-card" key={targetKey(target)}>
                          <label className="cao-target-choice">
                            <input
                              type="checkbox"
                              checked={selectedTargets.has(targetKey(target))}
                              disabled={busy || !target.identity || target.status === 'archived'}
                              onChange={(event) =>
                                setSelectedTargets((current) => {
                                  const next = new Set(current);
                                  if (event.target.checked) next.add(targetKey(target));
                                  else next.delete(targetKey(target));
                                  return next;
                                })
                              }
                            />
                            <span>
                              <strong>{target.title}</strong>
                              <small>
                                {target.identity
                                  ? `${target.identity.backend === 'codex' ? 'Codex' : 'OpenCode'} · ${target.identity.modelId} · ${target.identity.reasoningEffort}`
                                  : 'No verified live route'}
                              </small>
                            </span>
                          </label>
                        </article>
                      ))}
                    </section>
                  );
                })}
              </div>
            )}
            {step === 3 && (
              <div className="space-y-4">
                <JevCredentialCard />
                <p className="text-xs text-muted-foreground">
                  Sentinel also respects your existing CAO learning and approval settings. A saved
                  key alone does not prove that checks are running; completed checks appear in the
                  live overview.
                </p>
              </div>
            )}
            {step === 4 && (
              <div className="space-y-4">
                <CaoDeskScene
                  workers={selectedTargetRows.map((target) => ({
                    targetId: target.targetId,
                    kind: target.kind,
                    backend: target.identity?.backend,
                    modelId: target.identity?.modelId,
                    reasoningEffort: target.identity?.reasoningEffort,
                    assignment: 'CAO will assign work after the mission starts.',
                    ownedPaths: [],
                    status: 'assigned',
                    lastObservedRevision: null,
                  }))}
                />
                <article className="cao-target-card">
                  <span className="cao-eyebrow">MISSION BRIEF</span>
                  <p className="mt-2 whitespace-pre-wrap">{objective}</p>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Coordinator: {modelId} · {reasoningEffort} · {connectionId}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Checker: Jev / Sentinel · existing approval policy
                  </p>
                </article>
                {selectedTargetRows.map((target) => (
                  <article className="cao-target-card" key={targetKey(target)}>
                    <strong>{target.title}</strong>
                    <p className="mt-2 text-sm whitespace-pre-wrap">
                      CAO will analyze this agent’s current context and assign its part of the
                      mission.
                    </p>
                  </article>
                ))}
              </div>
            )}
            <footer className="cao-wizard-actions">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy || step === 0}
                onClick={() => {
                  setError('');
                  setStep((current) => current - 1);
                }}
              >
                Back
              </Button>
              {step < steps.length - 1 ? (
                <Button
                  type="button"
                  disabled={busy || (step === 1 && (!selectedIdentity || catalogBusy))}
                  onClick={() => void nextStep()}
                >
                  {busy ? 'Saving…' : step === 3 ? 'Review mission' : 'Continue'}
                </Button>
              ) : (
                <Button
                  type="button"
                  disabled={
                    busy || !controller || !savedProfile || profileDirty || Boolean(activeMission)
                  }
                  onClick={() => void startMission()}
                >
                  {busy ? 'Starting…' : 'Run mission'}
                </Button>
              )}
            </footer>
          </>
        )}
        {catalogError && step === 1 && !showOverview && (
          <p role="alert" className="text-sm text-destructive">
            {catalogError}
          </p>
        )}
        {displayedError && (
          <p role="alert" className="text-sm text-destructive">
            {displayedError}
          </p>
        )}
        {error && scopeUnavailable && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void restoreLocalProject()}
          >
            {busy ? 'Restoring…' : 'Restore local project'}
          </Button>
        )}
        {notice && (
          <p role="status" className="text-xs text-muted-foreground">
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}
