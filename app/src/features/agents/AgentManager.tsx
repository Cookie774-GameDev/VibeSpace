/**
 * AgentManager - the settings-section UI for viewing, editing, cloning, and
 * moving user-created agents into the recoverable Recycle Bin.
 *
 * Layout: a list of agents on the left, a detail editor on the right.
 * whenever the selection changes. "Save" persists the diff to IndexedDB and
 * updates the runtime store; "Clone" creates a durable non-builtin copy with a
 * fresh id; "Delete" archives a non-builtin agent for 90-day recovery.
 */
import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Cpu,
  FlaskConical,
  HardDrive,
  Loader2,
  Lock,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type {
  Agent,
  AgentCapability,
  AgentEffort,
  AgentEffortCustom,
  AgentId,
  AgentPersona,
  MemoryScope,
  ProviderId,
} from '@/types';
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
import { jarvisProfileRepo } from '@/lib/db/jarvisRepositories';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { isProtectedJarvisAgent } from '@/lib/jarvis/identity';
import type { JarvisProfile } from '@/lib/jarvis/profiles/types';
import { AgentBadge } from './AgentBadge';
import { hasNoBsPromptSection, setNoBsPromptSection } from './noBs';
import { NoBsCinematic } from './NoBsCinematic';
import { EmojiPicker } from '@/features/emoji/EmojiPicker';
import { getDefaultAgents } from './registry';
import { getAgentRole, ROLE_PERSONAS, type AgentRole } from './personas';
import { getProviderDisplayName } from '@/lib/ai/providerRegistry';
import {
  agentEditorProviderFromAgent,
  agentModelFromEditorChoice,
  AGENT_DEFAULT_PROVIDER_MODEL,
  getAgentEditorProviderOptions,
  type AgentEditorProviderChoice,
} from '@/lib/ai/agentProviderOptions';
import { getModelsForProvider } from '@/lib/ai/providerModelCatalog';
import { useProviderConnectionContext } from '@/lib/ai/useProviderModelOptions';
import { useOllamaModelOptions, syncDiscoveredOllamaModels } from '@/lib/ai/models';
import {
  isValidMaxOutputTokens,
  RECOMMENDED_MAX_OUTPUT_TOKENS,
} from '@/lib/agents/applyAgentConfig';
import {
  getAllCatalogSkills,
  normalizePresetSkillId,
  resolveCatalogSkill,
} from '@/features/skills/skillCatalog';
import {
  JARVIS_CREATOR_APPLY_AGENT_EVENT,
  type JarvisCreatorAgentDraft,
} from '@/features/jarvis-creator/contracts';
import { startJarvisCreator } from '@/features/jarvis-creator/launcher';
import { BuildYourOwnAIHub } from '@/features/model-foundry';
import { RecycleBinConfirmDialog } from '@/features/recycle-bin/RecycleBinConfirmDialog';
import { recycleBinService } from '@/features/recycle-bin/recycleBinService';
import {
  foundryModelOptions,
  loadJobs as loadFoundryJobs,
  type FoundryJob,
} from '@/features/model-foundry/modelHub';
import './sakura-agents.css';

/** Strong visual marks for providers in the agent editor. */
const PROVIDER_MARK: Partial<
  Record<ProviderId | 'default', { label: string; hue: number; Icon: LucideIcon }>
> = {
  default: { label: 'DF', hue: 200, Icon: Sparkles },
  ollama: { label: 'LM', hue: 150, Icon: HardDrive },
  local: { label: 'LM', hue: 150, Icon: HardDrive },
  google: { label: 'G', hue: 210, Icon: Sparkles },
  openai: { label: 'OA', hue: 160, Icon: Sparkles },
  anthropic: { label: 'AN', hue: 20, Icon: Sparkles },
  xai: { label: 'X', hue: 0, Icon: Sparkles },
  deepseek: { label: 'DS', hue: 230, Icon: Cpu },
  groq: { label: 'GQ', hue: 280, Icon: Cpu },
  mistral: { label: 'MI', hue: 250, Icon: Sparkles },
  openrouter: { label: 'OR', hue: 300, Icon: Sparkles },
  mock: { label: 'MK', hue: 45, Icon: Sparkles },
};

function ProviderMark({ provider }: { provider: ProviderId | 'default' }) {
  const mark = PROVIDER_MARK[provider] ?? {
    label: provider.slice(0, 2).toUpperCase(),
    hue: 200,
    Icon: Sparkles,
  };
  const Icon = mark.Icon;
  return (
    <span
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-[10px] font-bold tracking-tight"
      style={{
        background: `hsl(${mark.hue} 45% 18%)`,
        color: `hsl(${mark.hue} 70% 72%)`,
        borderColor: `hsl(${mark.hue} 40% 32%)`,
      }}
      title={provider === 'default' ? 'Default provider' : getProviderDisplayName(provider)}
      aria-hidden
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

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
  tools_allowed: string[];
  memory_scope: MemoryScope;
  capabilities: AgentCapability[];
  skills: string[];
  max_output_tokens: number | null;
  color_hue: number | null;
  emoji: string | undefined;
  effort: AgentEffort;
  effort_custom: AgentEffortCustom | null;
  persona: AgentPersona;
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
    tools_allowed: [...a.tools_allowed],
    memory_scope: a.memory_scope,
    capabilities: [...a.capabilities],
    skills: [...(a.skills ?? [])],
    max_output_tokens: a.max_output_tokens ?? null,
    color_hue: a.color_hue ?? null,
    emoji: a.emoji,
    effort: a.effort ?? 'medium',
    effort_custom: a.effort_custom ? { ...a.effort_custom } : null,
    persona: a.persona ?? 'jarvis',
  };
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function normalizePromptForComparison(value: string): string {
  return normalizeLineEndings(value).replace(/[ \t]+$/gm, '');
}

function normalizeUnordered(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function normalizedDraft(draft: DraftState, ignoreSystemPrompt = false): unknown {
  const normalized = {
    ...draft,
    name: draft.name.trim(),
    description: draft.description.trim(),
    system_prompt: normalizePromptForComparison(draft.system_prompt),
    tools_allowed: normalizeUnordered(draft.tools_allowed),
    capabilities: normalizeUnordered(draft.capabilities),
    skills: normalizeUnordered(draft.skills),
    effort_custom: draft.effort === 'custom' ? draft.effort_custom : null,
  };
  if (ignoreSystemPrompt) delete (normalized as Partial<DraftState>).system_prompt;
  return normalized;
}

function draftsDiffer(
  draft: DraftState,
  baseline: DraftState,
  ignoreSystemPrompt = false,
): boolean {
  return (
    JSON.stringify(normalizedDraft(draft, ignoreSystemPrompt)) !==
    JSON.stringify(normalizedDraft(baseline, ignoreSystemPrompt))
  );
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatList(values: readonly string[]): string {
  return values.join(', ');
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

type SaveErrorState = {
  kind: 'agent' | 'profile' | 'partial' | 'validation' | 'conflict';
  message: string;
};

type EditorStatus =
  | 'idle'
  | 'unsaved'
  | 'saving'
  | 'saved'
  | 'conflict'
  | 'validation-error'
  | 'error';

type ProtectedProfileState =
  | { status: 'idle'; requestGeneration: number }
  | {
      status: 'loading';
      requestGeneration: number;
      accountId: string;
      accountScopeKey: string;
    }
  | {
      status: 'unavailable';
      requestGeneration: number;
      accountId?: string;
      accountScopeKey?: string;
    }
  | {
      status: 'ready';
      requestGeneration: number;
      accountId: string;
      accountScopeKey: string;
      profile: JarvisProfile;
      draft: string;
      baseline: string;
    };

function accountScopeKey(identity: { source: 'supabase' | 'local'; accountId: string }): string {
  return `${identity.source}\u0000${identity.accountId}`;
}

export function AgentManager() {
  const agents = useAgentStore((s) => s.agents);
  const registerMany = useAgentStore((s) => s.registerMany);
  const registerAgent = useAgentStore((s) => s.registerAgent);

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
  const [modelFoundryOpen, setModelFoundryOpen] = React.useState(false);
  const [deleteCandidate, setDeleteCandidate] = React.useState<Agent | null>(null);
  const [activatedFoundryJob, setActivatedFoundryJob] = React.useState<FoundryJob | null>(null);

  // Auto-select the first agent when the list materialises or the current one
  // is removed.
  React.useEffect(() => {
    if (selectedId && agents[selectedId]) return;
    setSelectedId(agentList[0]?.id ?? null);
  }, [agentList, agents, selectedId]);

  const selectedAgent: Agent | null = selectedId ? (agents[selectedId] ?? null) : null;

  // Draft is reset whenever the *selection* changes (not when the agent
  // reference updates after a save).
  const [draft, setDraft] = React.useState<DraftState | null>(null);
  const [baseline, setBaseline] = React.useState<DraftState | null>(null);
  const [baselineUpdatedAt, setBaselineUpdatedAt] = React.useState<number | null>(null);
  const [saveState, setSaveState] = React.useState<SaveState>('idle');
  const [saveError, setSaveError] = React.useState<SaveErrorState | null>(null);
  const [showNoBsConfirmation, setShowNoBsConfirmation] = React.useState(false);
  const noBsToggleRef = React.useRef<HTMLButtonElement>(null);
  const [maxTokensMode, setMaxTokensMode] = React.useState<'recommended' | 'custom'>('recommended');
  const draftRef = React.useRef<DraftState | null>(null);
  const baselineRef = React.useRef<DraftState | null>(null);
  const baselineUpdatedAtRef = React.useRef<number | null>(null);
  const savingRef = React.useRef(false);
  const selectedIdRef = React.useRef<AgentId | null>(selectedId);
  const [protectedProfile, setProtectedProfile] = React.useState<ProtectedProfileState>({
    status: 'idle',
    requestGeneration: 0,
  });
  const protectedProfileRef = React.useRef<ProtectedProfileState>(protectedProfile);
  const profileRequestGenerationRef = React.useRef(0);
  draftRef.current = draft;
  baselineRef.current = baseline;
  protectedProfileRef.current = protectedProfile;
  selectedIdRef.current = selectedId;
  React.useEffect(() => {
    const next = selectedAgent ? agentToDraft(selectedAgent) : null;
    setDraft(next);
    setBaseline(next);
    setBaselineUpdatedAt(selectedAgent?.updated_at ?? null);
    baselineUpdatedAtRef.current = selectedAgent?.updated_at ?? null;
    setMaxTokensMode(
      selectedAgent?.max_output_tokens == null || selectedAgent.max_output_tokens === undefined
        ? 'recommended'
        : 'custom',
    );
    setSaveState('idle');
    setSaveError(null);
    draftRef.current = next;
    baselineRef.current = next;
    // Intentionally watch selectedAgent?.id, not the whole agent reference.
  }, [selectedAgent?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    const handleApply = (event: Event) => {
      const detail = (event as CustomEvent<JarvisCreatorAgentDraft>).detail;
      if (!detail?.name || !detail.description || !detail.system_prompt) return;
      setDraft((current) =>
        current
          ? {
              ...current,
              name: detail.name,
              description: detail.description,
              system_prompt: detail.system_prompt,
              temperature: detail.temperature,
            }
          : current,
      );
    };
    window.addEventListener(JARVIS_CREATOR_APPLY_AGENT_EVENT, handleApply as EventListener);
    return () =>
      window.removeEventListener(JARVIS_CREATOR_APPLY_AGENT_EVENT, handleApply as EventListener);
  }, []);

  const apiKeys = useAuthStore((s) => s.apiKeys);
  const offlineMode = useAuthStore((s) => s.offlineMode);
  const plan = useAuthStore((s) => s.plan);
  const defaultProvider = useAuthStore((s) => s.defaultProvider);
  const defaultLocalModel = useAuthStore((s) => s.defaultLocalModel);
  const cloudSession = useAuthStore((s) => s.cloudSession);
  const localUserId = useAuthStore((s) => s.localUserId);
  const accountIdentity = resolveAccountIdentity({ cloudSession, localUserId });
  const currentAccountScopeKey = accountIdentity ? accountScopeKey(accountIdentity) : null;
  const protectedJarvis = selectedAgent ? isProtectedJarvisAgent(selectedAgent) : false;
  const ollamaOptions = useOllamaModelOptions();

  React.useEffect(() => {
    const requestGeneration = ++profileRequestGenerationRef.current;
    if (!protectedJarvis) {
      setProtectedProfile({ status: 'idle', requestGeneration });
      return;
    }
    if (!accountIdentity) {
      setProtectedProfile({ status: 'unavailable', requestGeneration });
      return;
    }

    const { accountId } = accountIdentity;
    const requestedAccountScopeKey = accountScopeKey(accountIdentity);
    let cancelled = false;
    setProtectedProfile({
      status: 'loading',
      requestGeneration,
      accountId,
      accountScopeKey: requestedAccountScopeKey,
    });
    void jarvisProfileRepo.getActive(accountId).then(
      (profile) => {
        if (cancelled || profileRequestGenerationRef.current !== requestGeneration) return;
        if (!profile || !profile.active || profile.accountId !== accountId) {
          setProtectedProfile({
            status: 'unavailable',
            requestGeneration,
            accountId,
            accountScopeKey: requestedAccountScopeKey,
          });
          return;
        }
        setProtectedProfile({
          status: 'ready',
          requestGeneration,
          accountId,
          accountScopeKey: requestedAccountScopeKey,
          profile,
          draft: profile.customInstructions,
          baseline: profile.customInstructions,
        });
      },
      () => {
        if (cancelled || profileRequestGenerationRef.current !== requestGeneration) return;
        setProtectedProfile({
          status: 'unavailable',
          requestGeneration,
          accountId,
          accountScopeKey: requestedAccountScopeKey,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [accountIdentity?.accountId, accountIdentity?.source, protectedJarvis, selectedAgent?.id]);

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

  const providerCtx = useProviderConnectionContext();

  const providerOptions = React.useMemo(
    () =>
      getAgentEditorProviderOptions({
        apiKeys,
        offlineMode,
        plan,
        defaultProvider,
        defaultLocalModel,
      }),
    [apiKeys, offlineMode, plan, defaultProvider, defaultLocalModel, ollamaOptions],
  );
  const providerChoiceAvailable =
    !draft || providerOptions.some((option) => option.id === draft.providerChoice);
  const unavailableMockDefault =
    !!draft &&
    !providerChoiceAvailable &&
    draft.providerChoice === 'mock' &&
    draft.provider === 'mock' &&
    draft.model === 'mock-default';
  const defaultProviderGuidance =
    defaultProvider === 'ollama' || defaultProvider === 'local'
      ? 'Default provider (Local Models)'
      : (providerOptions.find((option) => option.id === 'default')?.label ?? 'Default provider');

  const modelOptions = React.useMemo(() => {
    if (!draft || draft.providerChoice === 'default') return [];
    const providerModels = getModelsForProvider(draft.providerChoice, providerCtx);
    if (draft.providerChoice !== 'ollama' && draft.providerChoice !== 'local') {
      return providerModels;
    }
    const persisted = foundryModelOptions(loadFoundryJobs(window.localStorage));
    const activated = activatedFoundryJob ? foundryModelOptions([activatedFoundryJob]) : [];
    const foundry = [...persisted, ...activated].filter(
      (option, index, all) => all.findIndex((candidate) => candidate.id === option.id) === index,
    );
    return [...foundry, ...providerModels];
  }, [activatedFoundryJob, draft, providerCtx, ollamaOptions]);

  const visibleProtectedProfile =
    protectedJarvis &&
    currentAccountScopeKey !== null &&
    'accountId' in protectedProfile &&
    protectedProfile.accountScopeKey === currentAccountScopeKey
      ? protectedProfile
      : null;
  const protectedProfileReady = visibleProtectedProfile?.status === 'ready';
  const customInstructions =
    visibleProtectedProfile?.status === 'ready' ? visibleProtectedProfile.draft : '';
  const editablePrompt = protectedJarvis ? customInstructions : (draft?.system_prompt ?? '');
  const noBsEnabled = hasNoBsPromptSection(editablePrompt);

  const updateEditablePrompt = React.useCallback(
    (nextPrompt: string) => {
      if (!protectedJarvis) {
        setDraft((current) => (current ? { ...current, system_prompt: nextPrompt } : current));
        return;
      }
      setProtectedProfile((current) => {
        if (
          current.status !== 'ready' ||
          !accountIdentity ||
          current.accountId !== accountIdentity.accountId
        )
          return current;
        return { ...current, draft: nextPrompt };
      });
    },
    [accountIdentity, protectedJarvis],
  );

  const handleNoBsToggle = () => {
    if (protectedJarvis && !protectedProfileReady) return;
    const nextEnabled = !noBsEnabled;
    updateEditablePrompt(setNoBsPromptSection(editablePrompt, nextEnabled));
    setShowNoBsConfirmation(nextEnabled);
  };
  const handleNoBsCinematicComplete = React.useCallback(() => {
    setShowNoBsConfirmation(false);
    noBsToggleRef.current?.focus({ preventScroll: true });
  }, []);
  const agentDirty = !!(draft && baseline && draftsDiffer(draft, baseline, protectedJarvis));
  const profileDirty = !!(
    visibleProtectedProfile?.status === 'ready' &&
    normalizeLineEndings(visibleProtectedProfile.draft) !==
      normalizeLineEndings(visibleProtectedProfile.baseline)
  );
  const dirty = agentDirty || profileDirty;
  const concurrentConflict = !!(
    selectedAgent &&
    baselineUpdatedAt !== null &&
    selectedAgent.updated_at > baselineUpdatedAt &&
    dirty &&
    saveState !== 'saving'
  );
  const agentModelAvailable =
    !draft ||
    draft.providerChoice === 'default' ||
    modelOptions.some((option) => option.id === draft.model);
  const catalogSkillIds = React.useMemo(
    () => new Set(getAllCatalogSkills().map((skill) => skill.id)),
    [],
  );
  const validationError = (() => {
    if (!draft) return 'No agent is selected.';
    if (!draft.name.trim()) return 'Agent name is required.';
    if (!draft.description.trim()) return 'Agent description is required.';
    if (!protectedJarvis && !draft.system_prompt.trim()) return 'System prompt is required.';
    if (!agentModelAvailable) return 'Select an available model before saving.';
    if (!Number.isFinite(draft.temperature) || draft.temperature < 0 || draft.temperature > 2) {
      return 'Temperature must be between 0 and 2.';
    }
    if (!isValidMaxOutputTokens(draft.max_output_tokens)) {
      return 'Max output tokens must be a positive whole number (or Recommended default).';
    }
    if (
      draft.color_hue !== null &&
      (!Number.isInteger(draft.color_hue) || draft.color_hue < 0 || draft.color_hue > 359)
    ) {
      return 'Color hue must be a whole number from 0 to 359.';
    }
    const unknownSkills = draft.skills.filter((id) => {
      if (id.startsWith('role:')) return false;
      const normalized = normalizePresetSkillId(id);
      return !catalogSkillIds.has(normalized) && !resolveCatalogSkill(id);
    });
    if (unknownSkills.length > 0) {
      return `Unknown skill id(s): ${unknownSkills.join(', ')}. Use catalog skill ids so they load at runtime.`;
    }
    return null;
  })();
  const editorStatus: EditorStatus = (() => {
    if (saveState === 'saving') return 'saving';
    if (saveState === 'saved') return 'saved';
    if (concurrentConflict || saveState === 'conflict') return 'conflict';
    if (saveError && saveState === 'error') return 'error';
    if (dirty && validationError) return 'validation-error';
    if (dirty) return 'unsaved';
    return 'idle';
  })();
  const saveDisabled =
    !dirty || Boolean(validationError) || saveState === 'saving' || concurrentConflict;

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

  const handleSave = React.useCallback(async () => {
    const currentDraft = draftRef.current;
    const currentBaseline = baselineRef.current;
    const currentProtectedJarvis = selectedAgent ? isProtectedJarvisAgent(selectedAgent) : false;
    const currentProfile = protectedProfileRef.current;
    const currentIdentity = resolveAccountIdentity(useAuthStore.getState());
    const submittedAgentId = selectedAgent?.id ?? null;
    const submittedAccountScopeKey = currentIdentity ? accountScopeKey(currentIdentity) : null;
    const currentAgentDirty = !!(
      currentDraft &&
      currentBaseline &&
      draftsDiffer(currentDraft, currentBaseline, currentProtectedJarvis)
    );
    const currentProfileDirty = !!(
      currentProtectedJarvis &&
      currentIdentity &&
      currentProfile.status === 'ready' &&
      currentProfile.accountScopeKey === submittedAccountScopeKey &&
      currentProfile.requestGeneration === profileRequestGenerationRef.current &&
      normalizeLineEndings(currentProfile.draft) !== normalizeLineEndings(currentProfile.baseline)
    );
    if (
      savingRef.current ||
      !selectedAgent ||
      !currentDraft ||
      !currentBaseline ||
      (!currentAgentDirty && !currentProfileDirty)
    )
      return;
    if (validationError) {
      setSaveState('error');
      setSaveError({ kind: 'validation', message: validationError });
      return;
    }
    const liveAgent = selectedAgent ? useAgentStore.getState().agents[selectedAgent.id] : undefined;
    if (
      liveAgent &&
      baselineUpdatedAtRef.current !== null &&
      liveAgent.updated_at > baselineUpdatedAtRef.current
    ) {
      setSaveState('conflict');
      setSaveError({
        kind: 'conflict',
        message:
          'This agent changed elsewhere while you were editing. Reload the latest version or discard your edits, then try again.',
      });
      return;
    }
    savingRef.current = true;
    setSaveState('saving');
    setSaveError(null);
    const patch: Partial<Agent> = {
      name: currentDraft.name,
      description: currentDraft.description,
      model: {
        ...selectedAgent.model,
        provider: currentDraft.provider,
        model: currentDraft.model,
      },
      temperature: currentDraft.temperature,
      tools_allowed: normalizeUnordered(currentDraft.tools_allowed),
      memory_scope: currentDraft.memory_scope,
      capabilities: normalizeUnordered(currentDraft.capabilities) as AgentCapability[],
      skills: normalizeUnordered(currentDraft.skills),
      max_output_tokens: currentDraft.max_output_tokens ?? undefined,
      color_hue: currentDraft.color_hue ?? undefined,
      emoji: currentDraft.emoji,
      effort: currentDraft.effort,
      effort_custom:
        currentDraft.effort === 'custom' && currentDraft.effort_custom
          ? { ...currentDraft.effort_custom }
          : undefined,
      persona: currentDraft.persona,
    };
    if (!currentProtectedJarvis) patch.system_prompt = currentDraft.system_prompt;
    let agentChangesSaved = false;
    try {
      let savedAgent = selectedAgent;
      let hasNewerAgentEdits = false;
      let hasNewerProfileEdits = false;
      let profileWriteCompleted = !currentProfileDirty;
      let existingAgent: Agent | undefined;
      if (currentProtectedJarvis || currentAgentDirty) {
        existingAgent = await agentRepo.getById(selectedAgent.id);
      }
      if (currentProtectedJarvis && (!existingAgent || !isProtectedJarvisAgent(existingAgent))) {
        throw new Error('Protected JARVIS agent row is unavailable.');
      }
      if (currentAgentDirty) {
        savedAgent = existingAgent
          ? await agentRepo.update(selectedAgent.id, patch)
          : await agentRepo.create({ ...selectedAgent, ...patch, id: selectedAgent.id });
        agentChangesSaved = true;
        registerAgent(savedAgent);
        if (selectedIdRef.current === submittedAgentId) {
          const syncedDraft = agentToDraft(savedAgent);
          const latestDraft = draftRef.current;
          hasNewerAgentEdits = !!(
            latestDraft && draftsDiffer(latestDraft, currentDraft, currentProtectedJarvis)
          );
          const nextDraft = hasNewerAgentEdits && latestDraft ? latestDraft : syncedDraft;
          setDraft(nextDraft);
          setBaseline(syncedDraft);
          setBaselineUpdatedAt(savedAgent.updated_at);
          baselineUpdatedAtRef.current = savedAgent.updated_at;
          setMaxTokensMode(
            savedAgent.max_output_tokens == null || savedAgent.max_output_tokens === undefined
              ? 'recommended'
              : 'custom',
          );
          draftRef.current = nextDraft;
          baselineRef.current = syncedDraft;
        }
      }

      if (currentProfileDirty && currentIdentity && currentProfile.status === 'ready') {
        const liveIdentity = resolveAccountIdentity(useAuthStore.getState());
        const liveAccountScopeKey = liveIdentity ? accountScopeKey(liveIdentity) : null;
        const liveSelectedId = selectedIdRef.current;
        const liveSelectedAgent = liveSelectedId
          ? useAgentStore.getState().agents[liveSelectedId]
          : null;
        const latestProfile = protectedProfileRef.current;
        const profileWriteStillAuthorized =
          liveSelectedId === submittedAgentId &&
          liveSelectedAgent !== undefined &&
          liveSelectedAgent !== null &&
          isProtectedJarvisAgent(liveSelectedAgent) &&
          liveAccountScopeKey === submittedAccountScopeKey &&
          profileRequestGenerationRef.current === currentProfile.requestGeneration &&
          latestProfile.status === 'ready' &&
          latestProfile.requestGeneration === currentProfile.requestGeneration &&
          latestProfile.accountScopeKey === submittedAccountScopeKey &&
          latestProfile.profile.id === currentProfile.profile.id;

        if (profileWriteStillAuthorized) {
          const savedProfile = await jarvisProfileRepo.updateCustomInstructions(
            currentIdentity.accountId,
            currentProfile.profile.id,
            currentProfile.draft,
          );
          const profileAfterSave = protectedProfileRef.current;
          if (
            selectedIdRef.current === submittedAgentId &&
            profileAfterSave.status === 'ready' &&
            profileAfterSave.requestGeneration === currentProfile.requestGeneration &&
            profileAfterSave.accountScopeKey === submittedAccountScopeKey &&
            profileAfterSave.profile.id === currentProfile.profile.id
          ) {
            hasNewerProfileEdits =
              normalizeLineEndings(profileAfterSave.draft) !==
              normalizeLineEndings(currentProfile.draft);
            const nextProfile: ProtectedProfileState = {
              ...profileAfterSave,
              profile: savedProfile,
              draft: hasNewerProfileEdits
                ? profileAfterSave.draft
                : savedProfile.customInstructions,
              baseline: savedProfile.customInstructions,
            };
            protectedProfileRef.current = nextProfile;
            setProtectedProfile(nextProfile);
            profileWriteCompleted = true;
          }
        }
      }

      const finalDraft = draftRef.current;
      const finalBaseline = baselineRef.current;
      const finalProfile = protectedProfileRef.current;
      const finalIdentity = resolveAccountIdentity(useAuthStore.getState());
      const finalAccountScopeKey = finalIdentity ? accountScopeKey(finalIdentity) : null;
      const liveAgentDirty = !!(
        finalDraft &&
        finalBaseline &&
        draftsDiffer(finalDraft, finalBaseline, currentProtectedJarvis)
      );
      const liveProfileDirty = !!(
        currentProtectedJarvis &&
        finalProfile.status === 'ready' &&
        finalProfile.accountScopeKey === submittedAccountScopeKey &&
        normalizeLineEndings(finalProfile.draft) !== normalizeLineEndings(finalProfile.baseline)
      );
      if (
        selectedIdRef.current === submittedAgentId &&
        (!currentProtectedJarvis || finalAccountScopeKey === submittedAccountScopeKey) &&
        profileWriteCompleted &&
        !liveAgentDirty &&
        !liveProfileDirty
      ) {
        setSaveState('saved');
        toast.success('Saved', `Updated "${savedAgent.name}"`);
      } else if (selectedIdRef.current === submittedAgentId) {
        setSaveState('idle');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save this agent.';
      if (selectedIdRef.current === submittedAgentId) {
        const kind: SaveErrorState['kind'] =
          agentChangesSaved && currentProfileDirty
            ? 'partial'
            : currentProfileDirty && !currentAgentDirty
              ? 'profile'
              : 'agent';
        setSaveState('error');
        setSaveError({ kind, message });
        toast.error(kind === 'partial' ? 'Profile save failed' : 'Save failed', message);
      }
    } finally {
      savingRef.current = false;
    }
  }, [registerAgent, selectedAgent, validationError]);

  React.useEffect(() => {
    const handleKeyboardSave = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type === 'file') return;
      if (!dirty) return;
      event.preventDefault();
      void handleSave();
    };
    window.addEventListener('keydown', handleKeyboardSave);
    return () => window.removeEventListener('keydown', handleKeyboardSave);
  }, [dirty, handleSave]);

  React.useEffect(() => {
    if (saveState !== 'saved') return;
    const timer = window.setTimeout(() => setSaveState('idle'), 1800);
    return () => window.clearTimeout(timer);
  }, [saveState]);

  const selectAgent = (nextId: AgentId) => {
    if (nextId === selectedId) return;
    if (dirty && !window.confirm('Discard unsaved changes and switch agents?')) return;
    setSelectedId(nextId);
  };

  const handleReset = () => {
    if (!baseline) return;
    const next = {
      ...baseline,
      tools_allowed: [...baseline.tools_allowed],
      capabilities: [...baseline.capabilities],
      skills: [...baseline.skills],
    };
    setDraft(next);
    draftRef.current = next;
    setMaxTokensMode(baseline.max_output_tokens == null ? 'recommended' : 'custom');
    if (selectedAgent) {
      setBaselineUpdatedAt(selectedAgent.updated_at);
      baselineUpdatedAtRef.current = selectedAgent.updated_at;
    }
    setProtectedProfile((current) => {
      if (
        current.status !== 'ready' ||
        currentAccountScopeKey === null ||
        current.accountScopeKey !== currentAccountScopeKey
      )
        return current;
      return { ...current, draft: current.baseline };
    });
    setSaveState('idle');
    setSaveError(null);
  };

  const handleReloadFromStore = () => {
    if (!selectedAgent) return;
    const next = agentToDraft(selectedAgent);
    setDraft(next);
    setBaseline(next);
    setBaselineUpdatedAt(selectedAgent.updated_at);
    baselineUpdatedAtRef.current = selectedAgent.updated_at;
    setMaxTokensMode(
      selectedAgent.max_output_tokens == null || selectedAgent.max_output_tokens === undefined
        ? 'recommended'
        : 'custom',
    );
    draftRef.current = next;
    baselineRef.current = next;
    setSaveState('idle');
    setSaveError(null);
  };

  const handleClone = async () => {
    if (!selectedAgent || !draft) return;
    let clonedSystemPrompt = draft.system_prompt;
    if (protectedJarvis) {
      if (visibleProtectedProfile?.status !== 'ready') {
        toast.error('Clone failed', 'Profile is still loading.');
        return;
      }
      clonedSystemPrompt = visibleProtectedProfile.draft;
    }
    const id = newAgentId();
    const t = Date.now();
    const cloned: Agent = {
      ...selectedAgent,
      id,
      // Suffix the slug so it stays unique without collision logic.
      slug: `${selectedAgent.slug}_copy_${id.slice(-4)}`,
      name: draft.name + ' (copy)',
      description: draft.description,
      system_prompt: clonedSystemPrompt,
      model: { ...selectedAgent.model, provider: draft.provider, model: draft.model },
      temperature: draft.temperature,
      tools_allowed: [...draft.tools_allowed] as Agent['tools_allowed'],
      memory_scope: draft.memory_scope,
      capabilities: [...draft.capabilities],
      skills: [...draft.skills],
      max_output_tokens: draft.max_output_tokens ?? undefined,
      color_hue: draft.color_hue ?? undefined,
      emoji: draft.emoji,
      effort: draft.effort,
      effort_custom:
        draft.effort === 'custom' && draft.effort_custom ? { ...draft.effort_custom } : undefined,
      persona: draft.persona,
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
      toast.error(
        'Clone failed',
        err instanceof Error ? err.message : 'Could not clone this agent.',
      );
    }
  };

  const handleCreateNew = async () => {
    const id = newAgentId();
    const t = Date.now();
    const created: Agent = {
      id,
      slug: `custom_${id.slice(-8).toLowerCase()}`,
      name: 'New Agent',
      description: 'Describe what this agent does.',
      system_prompt: 'You are a helpful specialist. Be concise, specific, and actionable.',
      model: { provider: 'mock', model: AGENT_DEFAULT_PROVIDER_MODEL },
      tools_allowed: ['*'],
      memory_scope: 'project',
      capabilities: ['writing'],
      temperature: 0.7,
      emoji: 'vibe:aurora-spark',
      builtin: false,
      created_at: t,
      updated_at: t,
    };
    try {
      const saved = await agentRepo.create(created);
      registerAgent(saved);
      setSelectedId(saved.id);
      toast.success('Created', `"${saved.name}" is ready to edit.`);
    } catch (err) {
      toast.error(
        'Create failed',
        err instanceof Error ? err.message : 'Could not create this agent.',
      );
    }
  };

  const handleCreateWithJarvis = () => {
    startJarvisCreator({
      kind: 'agent',
      currentName: draft?.name ?? selectedAgent?.name,
      currentDescription: draft?.description ?? selectedAgent?.description,
    });
  };

  const seedDefaults = () => {
    const defaults = getDefaultAgents();
    registerMany(defaults);
    toast.success('Loaded', `${defaults.length} default agents added`);
  };

  return (
    <>
      <div
        data-monochrome-route="agents"
        className="flex h-full min-h-[520px] surface-panel rounded-lg overflow-hidden [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border [html[data-theme=monochrome]_&]:border-border [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:shadow-none"
      >
        {/* List pane */}
        <div
          data-monochrome-surface="agent-registry"
          className="w-64 border-r border-border flex flex-col bg-elevated [html[data-theme=monochrome]_&]:bg-panel"
        >
          <div className="px-3 py-2.5 flex items-center justify-between gap-2 [html[data-theme=monochrome]_&]:border-b [html[data-theme=monochrome]_&]:border-border">
            <div className="text-ui-strong text-foreground [html[data-theme=monochrome]_&]:font-mono [html[data-theme=monochrome]_&]:uppercase [html[data-theme=monochrome]_&]:tracking-wide">
              Agents
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setModelFoundryOpen(true)}
                aria-label="Build Your Own AI"
                title="Build a real local model"
                className="h-7 shrink-0 border border-accent-cyan/30 text-accent-cyan"
              >
                <FlaskConical className="h-3.5 w-3.5" />
                Build AI
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void handleCreateNew()}
                aria-label="New agent"
                title="New agent"
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
              <Badge variant="outline">{agentList.length}</Badge>
            </div>
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
                    onClick={() => selectAgent(agent.id)}
                    data-monochrome-state={active ? 'selected' : 'idle'}
                    className={cn(
                      'w-full text-left px-3 py-2 transition-colors flex items-center gap-2',
                      active ? 'bg-muted text-foreground' : 'hover:bg-muted/50',
                      '[html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-transparent [html[data-theme=monochrome]_&]:border-b [html[data-theme=monochrome]_&]:border-b-border [html[data-theme=monochrome]_&]:rounded-none',
                      active &&
                        '[html[data-theme=monochrome]_&]:border-l-accent-cyan [html[data-theme=monochrome]_&]:bg-muted',
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
        <div
          data-monochrome-surface="agent-editor"
          className="flex-1 overflow-y-auto [html[data-theme=monochrome]_&]:bg-background"
        >
          {selectedAgent && draft ? (
            <div className="p-5 space-y-5 max-w-3xl [html[data-theme=monochrome]_&]:space-y-3">
              {/* Header with actions */}
              <div className="flex items-start justify-between gap-3 [html[data-theme=monochrome]_&]:border-b [html[data-theme=monochrome]_&]:border-border [html[data-theme=monochrome]_&]:pb-3">
                <div className="flex items-center gap-3 min-w-0">
                  <AgentBadge
                    agent={{ ...selectedAgent, emoji: draft.emoji }}
                    showName={false}
                    size="lg"
                  />
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
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCreateWithJarvis}
                    className="border border-accent-cyan/35 bg-accent-cyan/10 text-accent-cyan hover:border-accent-cyan/60 hover:bg-accent-cyan/15"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Create with Jarvis
                  </Button>
                  {!selectedAgent.builtin && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteCandidate(selectedAgent)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="accent"
                    size="sm"
                    onClick={() => void handleSave()}
                    disabled={saveDisabled}
                    aria-label={
                      editorStatus === 'error' || editorStatus === 'conflict'
                        ? 'Retry save'
                        : 'Save agent'
                    }
                    data-monochrome-state={editorStatus}
                    data-editor-status={editorStatus}
                  >
                    {editorStatus === 'saving' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : editorStatus === 'saved' ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    {editorStatus === 'saving'
                      ? 'Saving...'
                      : editorStatus === 'saved'
                        ? 'Saved'
                        : editorStatus === 'error' || editorStatus === 'conflict'
                          ? 'Retry'
                          : 'Save'}
                  </Button>
                </div>
              </div>

              <Separator />

              {/* Editable fields */}
              <div className="space-y-4">
                <div
                  role="status"
                  aria-live="polite"
                  data-editor-status={editorStatus}
                  className={cn(
                    'flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-secondary',
                    editorStatus === 'unsaved' &&
                      'border-accent-copper/40 bg-accent-copper/5 text-foreground',
                    editorStatus === 'saving' && 'border-border bg-muted/40 text-muted-foreground',
                    editorStatus === 'saved' &&
                      'border-emerald-500/35 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300',
                    editorStatus === 'conflict' &&
                      'border-destructive/40 bg-destructive/5 text-destructive',
                    editorStatus === 'validation-error' &&
                      'border-destructive/40 bg-destructive/5 text-destructive',
                    editorStatus === 'error' &&
                      'border-destructive/40 bg-destructive/5 text-destructive',
                    editorStatus === 'idle' && 'border-border bg-muted/20 text-muted-foreground',
                  )}
                >
                  <Badge variant="outline" className="font-mono uppercase tracking-wide">
                    {editorStatus === 'validation-error' ? 'validation-error' : editorStatus}
                  </Badge>
                  <span>
                    {editorStatus === 'idle' && 'No unsaved changes.'}
                    {editorStatus === 'unsaved' && 'Unsaved changes — save to persist.'}
                    {editorStatus === 'saving' && 'Saving…'}
                    {editorStatus === 'saved' && 'Saved.'}
                    {editorStatus === 'conflict' &&
                      'Conflict — this agent changed elsewhere while you were editing.'}
                    {editorStatus === 'validation-error' &&
                      (validationError ?? 'Fix validation errors before saving.')}
                    {editorStatus === 'error' &&
                      (saveError?.message ?? 'Save failed. Retry when ready.')}
                  </span>
                  {editorStatus === 'conflict' ? (
                    <Button type="button" variant="ghost" size="sm" onClick={handleReloadFromStore}>
                      Reload latest
                    </Button>
                  ) : null}
                </div>
                {saveError ? (
                  <div
                    role="alert"
                    data-monochrome-state={saveError.kind}
                    className="flex items-start gap-2 rounded-md border border-destructive/35 bg-destructive/5 px-3 py-2 text-secondary text-destructive [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:bg-background"
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      {saveError.kind === 'partial'
                        ? 'Agent changes were saved, but custom instructions were not saved. Your profile edit is still here. '
                        : saveError.kind === 'profile'
                          ? 'Custom instructions were not saved. Your edits are still here. '
                          : saveError.kind === 'conflict'
                            ? 'Conflict: '
                            : saveError.kind === 'validation'
                              ? 'Validation error: '
                              : 'The Agent was not saved. Your edits are still here. '}
                      {saveError.message}
                    </span>
                  </div>
                ) : null}
                <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="agent-name">Name</Label>
                    <Input
                      id="agent-name"
                      value={draft.name}
                      onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="agent-desc">Description</Label>
                    <Input
                      id="agent-desc"
                      value={draft.description}
                      onChange={(e) =>
                        setDraft((d) => (d ? { ...d, description: e.target.value } : d))
                      }
                    />
                  </div>
                </div>

                <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="agent-provider">Provider</Label>
                    <div className="flex items-center gap-2">
                      <ProviderMark provider={draft.providerChoice} />
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
                        {!providerChoiceAvailable && draft.providerChoice !== 'default' ? (
                          <option value={draft.providerChoice} disabled>
                            ⚠ {getProviderDisplayName(draft.providerChoice)} — unavailable (current)
                          </option>
                        ) : null}
                        {providerOptions.map((opt) => (
                          <option key={opt.id} value={opt.id}>
                            {opt.id === 'ollama' || opt.id === 'local'
                              ? `● ${opt.label}`
                              : opt.id === 'default'
                                ? opt.label
                                : `☁ ${opt.label}`}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="agent-model">Model</Label>
                    {draft.providerChoice === 'default' ? (
                      <p
                        id="agent-model"
                        className="flex h-8 items-center gap-2 rounded-md border border-dashed border-border px-2 text-secondary text-muted-foreground"
                      >
                        <ProviderMark provider="default" />
                        Follows Settings → Providers → Default provider
                      </p>
                    ) : modelOptions.length > 0 ? (
                      <div className="flex items-center gap-2">
                        <ProviderMark provider={draft.providerChoice} />
                        <select
                          id="agent-model"
                          value={agentModelAvailable ? draft.model : ''}
                          onChange={(e) =>
                            setDraft((d) => (d ? { ...d, model: e.target.value } : d))
                          }
                          className={cn(
                            'flex h-8 w-full rounded-md border border-input bg-background px-2 text-body text-foreground',
                            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                            'transition-colors',
                          )}
                        >
                          {!agentModelAvailable ? (
                            <option value="" disabled>
                              Select a connected model
                            </option>
                          ) : null}
                          {modelOptions.map((opt) => (
                            <option key={opt.id} value={opt.id}>
                              {opt.label}
                              {opt.subtitle && opt.subtitle !== opt.label
                                ? ` (${opt.subtitle})`
                                : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <p
                        id="agent-model"
                        className="flex min-h-8 items-center gap-2 rounded-md border border-dashed border-accent-copper/35 bg-accent-copper/5 px-2 text-secondary text-muted-foreground"
                      >
                        <ProviderMark provider={draft.providerChoice} />
                        {unavailableMockDefault
                          ? `This agent is configured for Mock (demo), which is unavailable. Choose ${defaultProviderGuidance} or another connected provider.`
                          : draft.providerChoice === 'ollama' || draft.providerChoice === 'local'
                            ? 'No local models found — open Settings → Local Models to download one'
                            : `Connect ${getProviderDisplayName(draft.providerChoice)} in Settings → Providers to load models`}
                      </p>
                    )}
                    {!agentModelAvailable && modelOptions.length > 0 ? (
                      <p className="mt-1 text-[11px] text-destructive">
                        Select one of the connected models before saving this agent.
                      </p>
                    ) : null}
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
                      setDraft((d) => (d ? { ...d, temperature: Number(e.target.value) } : d))
                    }
                    className="w-full"
                    style={{ accentColor: 'hsl(var(--accent-cyan))' }}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="agent-prompt">
                    {protectedJarvis ? 'Custom instructions' : 'System prompt'}
                  </Label>
                  <button
                    ref={noBsToggleRef}
                    type="button"
                    role="checkbox"
                    aria-checked={noBsEnabled}
                    aria-label="NO BS — straight-to-the-point replies"
                    disabled={protectedJarvis && !protectedProfileReady}
                    data-enabled={noBsEnabled ? 'true' : 'false'}
                    onClick={handleNoBsToggle}
                    className={cn(
                      'group flex w-full items-center gap-3 rounded-lg border px-3.5 py-3 text-left transition-[border-color,background-color,box-shadow] duration-200',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                      noBsEnabled
                        ? 'border-emerald-400/55 bg-emerald-500/[0.08] shadow-[0_0_24px_hsl(155_70%_45%/0.10)]'
                        : 'border-border bg-muted/20 hover:border-foreground/25 hover:bg-muted/35',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-all duration-200',
                        noBsEnabled
                          ? 'border-emerald-400 bg-emerald-400 text-emerald-950 shadow-[0_0_14px_hsl(155_72%_55%/0.35)]'
                          : 'border-border bg-background text-transparent group-hover:border-foreground/35',
                      )}
                      aria-hidden
                    >
                      <CheckCircle2 className="h-[18px] w-[18px]" strokeWidth={2.7} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong className="block text-sm tracking-[0.08em] text-foreground">
                        NO BS
                      </strong>
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                        Straight to the point. No story, filler, praise, repetition, or unnecessary
                        preamble.
                      </span>
                    </span>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
                        noBsEnabled
                          ? 'bg-emerald-400/15 text-emerald-300'
                          : 'bg-muted text-muted-foreground',
                      )}
                      aria-hidden
                    >
                      {noBsEnabled ? 'On' : 'Off'}
                    </span>
                  </button>
                  <Textarea
                    id="agent-prompt"
                    value={editablePrompt}
                    disabled={protectedJarvis && !protectedProfileReady}
                    onChange={(event) =>
                      updateEditablePrompt(
                        noBsEnabled
                          ? setNoBsPromptSection(event.target.value, true)
                          : event.target.value,
                      )
                    }
                    className="min-h-[260px] font-mono text-secondary leading-relaxed"
                  />
                  {protectedJarvis && !protectedProfileReady ? (
                    <p className="text-metadata text-muted-foreground">Profile is still loading</p>
                  ) : null}
                  <div className="text-metadata text-muted-foreground">
                    {editablePrompt.length.toLocaleString()} chars · ~
                    {Math.ceil(editablePrompt.length / 4).toLocaleString()} tokens
                  </div>
                </div>

                <Separator />

                {/* Agent permissions and advanced settings */}
                <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="agent-capabilities">Capabilities</Label>
                    <Input
                      id="agent-capabilities"
                      value={formatList(draft.capabilities)}
                      placeholder="writing, planning"
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                capabilities: parseList(event.target.value) as AgentCapability[],
                              }
                            : current,
                        )
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="agent-skills">Skills</Label>
                    <Input
                      id="agent-skills"
                      value={formatList(draft.skills)}
                      placeholder="catalog skill ids, comma separated"
                      list="agent-skill-catalog"
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                skills: parseList(event.target.value),
                              }
                            : current,
                        )
                      }
                    />
                    <datalist id="agent-skill-catalog">
                      {Array.from(catalogSkillIds).map((id) => (
                        <option key={id} value={id} />
                      ))}
                    </datalist>
                    <p className="text-metadata text-muted-foreground">
                      Only catalog skill ids load at runtime (not decorative labels).
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="agent-tools">Allowed tools</Label>
                    <Input
                      id="agent-tools"
                      value={formatList(draft.tools_allowed)}
                      placeholder="* or tool ids"
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                tools_allowed: parseList(event.target.value),
                              }
                            : current,
                        )
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="agent-memory-scope">Memory scope</Label>
                    <select
                      id="agent-memory-scope"
                      value={draft.memory_scope}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                memory_scope: event.target.value as MemoryScope,
                              }
                            : current,
                        )
                      }
                      className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-body text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <option value="agent">Agent</option>
                      <option value="project">Project</option>
                      <option value="workspace">Workspace</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="agent-effort">Reasoning effort</Label>
                    <select
                      id="agent-effort"
                      value={draft.effort}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                effort: event.target.value as AgentEffort,
                              }
                            : current,
                        )
                      }
                      className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-body text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      {['minimal', 'low', 'medium', 'high', 'max', 'custom'].map((effort) => (
                        <option key={effort} value={effort}>
                          {effort}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="agent-persona">Persona</Label>
                    <select
                      id="agent-persona"
                      value={draft.persona}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                persona: event.target.value as AgentPersona,
                              }
                            : current,
                        )
                      }
                      className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-body text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      {['jarvis', 'friday'].map((persona) => (
                        <option key={persona} value={persona}>
                          {persona}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="agent-max-output-mode">Max output tokens</Label>
                    <select
                      id="agent-max-output-mode"
                      aria-label="Max output tokens"
                      value={maxTokensMode}
                      onChange={(event) => {
                        const mode = event.target.value as 'recommended' | 'custom';
                        setMaxTokensMode(mode);
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                max_output_tokens:
                                  mode === 'recommended' ? null : RECOMMENDED_MAX_OUTPUT_TOKENS,
                              }
                            : current,
                        );
                      }}
                      className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-body text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <option value="recommended">
                        Recommended default ({RECOMMENDED_MAX_OUTPUT_TOKENS})
                      </option>
                      <option value="custom">Custom</option>
                    </select>
                    {maxTokensMode === 'custom' ? (
                      <Input
                        id="agent-max-output"
                        type="number"
                        min={1}
                        max={1000000}
                        step={1}
                        value={draft.max_output_tokens ?? ''}
                        aria-label="Custom max output tokens"
                        placeholder={String(RECOMMENDED_MAX_OUTPUT_TOKENS)}
                        onChange={(event) => {
                          const raw = event.target.value;
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  max_output_tokens: raw === '' ? null : Number(raw),
                                }
                              : current,
                          );
                        }}
                      />
                    ) : (
                      <p className="text-metadata text-muted-foreground">
                        Uses the recommended default of {RECOMMENDED_MAX_OUTPUT_TOKENS} tokens.
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label>Agent emoji</Label>
                    <EmojiPicker
                      value={draft.emoji}
                      onChange={(emoji) =>
                        setDraft((current) => (current ? { ...current, emoji } : current))
                      }
                      label="Agent emoji"
                    />
                    <p className="text-metadata text-muted-foreground">
                      Choose from 100 VibeSpace icons or upload a compact custom image.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="agent-color-hue">
                      Appearance hue
                      <span className="ml-2 font-mono text-metadata text-muted-foreground">
                        {draft.color_hue === null ? 'Automatic' : draft.color_hue}
                      </span>
                    </Label>
                    <div className="flex items-center gap-3">
                      <span
                        className="h-7 w-7 shrink-0 rounded-full border border-border"
                        style={{
                          background:
                            draft.color_hue === null
                              ? 'hsl(var(--muted))'
                              : `hsl(${draft.color_hue}, 70%, 55%)`,
                        }}
                        aria-hidden
                      />
                      <input
                        id="agent-color-hue"
                        type="range"
                        min={0}
                        max={359}
                        step={1}
                        aria-label="Appearance hue"
                        value={draft.color_hue ?? 200}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  color_hue: Number(event.target.value),
                                }
                              : current,
                          )
                        }
                        className="w-full"
                        style={{ accentColor: `hsl(${draft.color_hue ?? 200}, 70%, 55%)` }}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setDraft((current) =>
                            current ? { ...current, color_hue: null } : current,
                          )
                        }
                      >
                        Auto
                      </Button>
                    </div>
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
      <BuildYourOwnAIHub
        open={modelFoundryOpen}
        onOpenChange={setModelFoundryOpen}
        onActivateArtifact={(job) => {
          setActivatedFoundryJob(job);
          setDraft((current) =>
            current
              ? {
                  ...current,
                  providerChoice: 'ollama',
                  provider: 'ollama',
                  model: `foundry:${job.id}`,
                }
              : current,
          );
          setModelFoundryOpen(false);
          toast.success('Local AI selected', `${job.name} is ready to save on this agent.`);
        }}
      />
      <NoBsCinematic open={showNoBsConfirmation} onComplete={handleNoBsCinematicComplete} />
      <RecycleBinConfirmDialog
        open={deleteCandidate !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteCandidate(null);
        }}
        title={`Move ${deleteCandidate?.name ?? 'agent'} to Recycle Bin?`}
        description="This removes the agent from active use. You can restore it from Settings → General for 90 days."
        confirmLabel="Move to Recycle Bin"
        onConfirm={async () => {
          if (!deleteCandidate) return;
          const name = deleteCandidate.name;
          await recycleBinService.moveAgentToRecycleBin(deleteCandidate);
          toast.info('Moved to Recycle Bin', `"${name}" can be restored for 90 days.`);
        }}
      />
    </>
  );
}
