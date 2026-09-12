import * as React from 'react';
import { ArrowRight, CheckCircle2, Cpu, Database, FlaskConical, Gauge, ShieldCheck, Sparkles } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { cn } from '../../lib/utils';
import { useAuthStore } from '../../stores/auth';
import { getPlan } from '../../lib/entitlements';
import type { FoundryResult, ProjectSnapshot, SpecialistDefinition, TrainingJobSnapshot } from './domain';
import { DeterministicFixtureBackend, type FixtureBackendDependencies } from './fixtureBackend';
import { VersionedFixtureRepository, type StorageAdapter } from './localRepository';
import { validateProjectSnapshot, VIBECODER_TEMPLATE } from './validation';
import { createFixtureBase, createFixtureDataset, createFixtureEvaluation } from './demoFixtures';
import {
  downloadFoundryModel,
  cancelFoundryTraining,
  evaluateFoundryArtifact,
  getFoundryHardwareProfile,
  generateFromFoundryArtifact,
  getFoundryTrainingRuntimeStatus,
  installFoundryTrainingDependencies,
  inspectFoundryArtifact,
  listenFoundryWorkerMessages,
  resumeFoundryTraining,
  startFoundryTraining,
  stopFoundryTrainingAfterCheckpoint,
  type FoundryHardwareProfile,
  type FoundryPrivateEvaluationCase,
  type FoundryTrainingRuntimeStatus,
} from './nativeBridge';
import { FOUNDRY_MODEL_CATALOG, modelCompatibility } from './modelRegistry';
import { DatasetStudioPanel } from './DatasetStudioPanel';
import { FoundryDeploymentRepository, type FoundryDeploymentRecord } from './deployment';
import { DeploymentPanel, EvaluationArenaPanel, FixtureEvaluationEvidencePanel, ImprovementPanel } from './FoundryGovernancePanels';
import { LocalAdapterRegistry, type LocalAdapterRecord } from './adapterRegistry';
import { RealAdapterRegistryPanel } from './RealAdapterRegistryPanel';
import { foundryMetadataSyncEnabled, queueFoundryMetadataDeletion, queueFoundryMetadataSync, setFoundryMetadataSyncEnabled } from './metadataSync';

export interface FoundryPageProps { readonly storage?: StorageAdapter; readonly dependencies?: FixtureBackendDependencies }

const browserStorage: StorageAdapter = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: (key) => window.localStorage.removeItem(key),
};
const defaultDependencies: FixtureBackendDependencies = {
  clock: () => new Date().toISOString(),
  idFactory: (kind) => `${kind}-${crypto.randomUUID()}`,
};
const NATIVE_RUN_STORAGE_KEY = 'vibespace.model-foundry.native-runs.v1';
const PRIVATE_EVALUATION_STORAGE_KEY = 'vibespace.model-foundry.private-evaluation-suites.v1';
const PROJECT_CATALOG_STORAGE_KEY = 'vibespace.model-foundry.project-catalog.v1';
const CREDENTIAL_SHAPED_TEXT = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{30,}|whsec_[A-Za-z0-9_-]{16,})\b|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@]+:[^\s@]+@/i;
const SPECIALIST_TEMPLATES = [
  { label: 'Support classifier', name: 'Support classifier', purpose: 'Classify a customer-support request into a reviewed routing category.', input: 'A local customer-support message.', output: 'One allowed routing category with confidence.', constraints: 'Use only the supplied message and never invent account data.' },
  { label: 'Data extractor', name: 'Structured data extractor', purpose: 'Extract a narrow set of fields from a supplied local document.', input: 'One local source document.', output: 'A validated structured record with requested fields.', constraints: 'Return only fields supported by the supplied document.' },
  { label: 'Document summary', name: 'Document summarizer', purpose: 'Summarize a supplied local document for a defined audience.', input: 'One local document and audience instruction.', output: 'A concise evidence-backed summary.', constraints: 'Do not add facts absent from the supplied document.' },
  { label: 'Command intent', name: 'Command intent classifier', purpose: 'Map a user request to one approved command intent.', input: 'A local natural-language request.', output: 'One allowed intent and extracted arguments.', constraints: 'Return unknown when no allowed intent is supported.' },
  { label: 'Writing style', name: 'Writing style adapter', purpose: 'Rewrite approved local text in the user-provided writing style.', input: 'A local source draft and approved style examples.', output: 'A rewritten draft that follows the supplied style.', constraints: 'Preserve factual meaning and never invent claims or personal details.' },
  { label: 'Product copy', name: 'Product description generator', purpose: 'Draft a product description from approved local facts.', input: 'A local product fact sheet.', output: 'A concise product description.', constraints: 'Do not claim features or outcomes absent from the fact sheet.' },
] as const;

function unwrap<T>(result: FoundryResult<T>): T { if (!result.ok) throw new Error(result.error.message); return result.value }
function titleCase(value: string) { return value.charAt(0).toUpperCase() + value.slice(1) }

interface NativeRunState {
  readonly jobId: string;
  readonly phase: string;
  readonly progress: number;
  readonly terminal: boolean;
  readonly detail: string;
}

function readPersistedNativeRun(storage: StorageAdapter, projectId: string): NativeRunState | null {
  try {
    const parsed = JSON.parse(storage.getItem(NATIVE_RUN_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    const candidate = parsed[projectId];
    if (!candidate || typeof candidate !== 'object') return null;
    const run = candidate as Partial<NativeRunState>;
    return typeof run.jobId === 'string' && typeof run.phase === 'string' && typeof run.progress === 'number' && typeof run.terminal === 'boolean' && typeof run.detail === 'string' ? run as NativeRunState : null;
  } catch { return null; }
}

function readPersistedPrivateEvaluationCases(storage: StorageAdapter, projectId: string): readonly FoundryPrivateEvaluationCase[] {
  try {
    const parsed = JSON.parse(storage.getItem(PRIVATE_EVALUATION_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    const rawCases = parsed[projectId];
    if (!Array.isArray(rawCases)) return [];
    return rawCases.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const candidate = value as Partial<FoundryPrivateEvaluationCase>;
      if (typeof candidate.id !== 'string' || !candidate.id || candidate.id.length > 128 || typeof candidate.prompt !== 'string' || candidate.prompt.length > 16_384 || typeof candidate.expectedCompletion !== 'string' || candidate.expectedCompletion.length > 12_000 || typeof candidate.hidden !== 'boolean') return [];
      return [{ id: candidate.id, prompt: candidate.prompt, expectedCompletion: candidate.expectedCompletion, hidden: candidate.hidden }];
    }).slice(0, 32);
  } catch { return []; }
}

function privateCaseContainsCredential(caseInput: FoundryPrivateEvaluationCase): boolean {
  return CREDENTIAL_SHAPED_TEXT.test(caseInput.prompt) || CREDENTIAL_SHAPED_TEXT.test(caseInput.expectedCompletion);
}

function readProjectCatalog(storage: StorageAdapter): readonly ProjectSnapshot[] {
  try {
    const parsed = JSON.parse(storage.getItem(PROJECT_CATALOG_STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      const validation = validateProjectSnapshot(value);
      return validation.valid ? [validation.value] : [];
    }).slice(0, 24);
  } catch { return []; }
}

function writeProjectCatalog(storage: StorageAdapter, snapshots: readonly ProjectSnapshot[]): void {
  storage.setItem(PROJECT_CATALOG_STORAGE_KEY, JSON.stringify(snapshots.slice(0, 24)));
}

function StepCard({ icon, title, detail, complete }: { icon: React.ReactNode; title: string; detail: string; complete: boolean }) {
  return <div className={cn('rounded-lg border p-3', complete ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-border bg-background/40')}>
    <div className="flex items-center gap-2 text-ui-strong"><span className={complete ? 'text-emerald-400' : 'text-muted-foreground'}>{complete ? <CheckCircle2 className="h-4 w-4" /> : icon}</span>{title}</div>
    <p className="mt-1 text-metadata text-muted-foreground">{detail}</p>
    {title === 'Promotion' && <MetadataSyncToggle />}
  </div>;
}

function OverviewStat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-border bg-background/35 p-3"><div className="text-metadata uppercase tracking-[0.14em] text-muted-foreground">{label}</div><div className="mt-1 text-secondary text-ui-strong">{value}</div></div>;
}

function MetadataSyncToggle() {
  const [enabled, setEnabled] = React.useState(false);
  const plan = useAuthStore((state) => state.plan);
  const cloudSync = getPlan(plan).cloudSync;
  React.useEffect(() => { setEnabled(foundryMetadataSyncEnabled(window.localStorage)); }, []);
  return <label className="mt-3 flex items-start gap-2 text-metadata text-muted-foreground"><input type="checkbox" disabled={!cloudSync} checked={enabled} onChange={(event) => { const next = event.target.checked; setFoundryMetadataSyncEnabled(window.localStorage, next); setEnabled(next); window.dispatchEvent(new CustomEvent('vibespace:foundry-metadata-sync-changed')); }} /><span>{cloudSync ? nextLabel(enabled) : 'Optional metadata sync is available with a plan that includes cloud sync. Local Foundry work remains unrestricted.'}</span></label>;
}

function nextLabel(enabled: boolean) { return enabled ? 'Metadata sync enabled: hashes and lifecycle status only. Turning it off queues deletion of cloud metadata.' : 'Enable optional metadata sync (never examples, prompts, outputs, paths, weights, or adapters).'; }

function customSpecialist(draft: { name: string; purpose: string; input: string; output: string; constraints: string; language: string; forbiddenAction: string; commercialIntent: SpecialistDefinition['commercialIntent']; latencyMs: number; memoryMb: number; threshold: number }, now: string): SpecialistDefinition {
  const name = draft.name.trim();
  const purpose = draft.purpose.trim();
  const input = draft.input.trim();
  const language = draft.language.trim();
  const forbiddenAction = draft.forbiddenAction.trim();
  const output = `${draft.output.trim()} in ${language}`;
  const constraints = `${draft.constraints.trim()} Never ${forbiddenAction}.`;
  if (!name || !purpose || !input || !language || !forbiddenAction || !draft.output.trim() || !draft.constraints.trim()) throw new Error('Complete the specialist name, narrow task, input, output, language, forbidden action, and constraint before creating it.');
  if (/\b(anything|everything|general[ -]?purpose|all tasks)\b/i.test(purpose)) throw new Error('Choose one narrow task; broad general-purpose specialists cannot be governed honestly.');
  if (!Number.isInteger(draft.latencyMs) || draft.latencyMs < 100 || draft.latencyMs > 120_000 || !Number.isInteger(draft.memoryMb) || draft.memoryMb < 64 || draft.memoryMb > 131_072 || !Number.isFinite(draft.threshold) || draft.threshold <= 0 || draft.threshold > 1) throw new Error('Use a latency from 100–120,000 ms, memory from 64–131,072 MB, and a passing score above 0 through 1.');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  if (slug.length < 2) throw new Error('Choose a specialist name with at least two letters or numbers.');
  return { ...VIBECODER_TEMPLATE, id: `custom-${slug}`, name, purpose, objective: purpose, expectedInputs: [input], expectedOutputs: [output], constraints: [constraints, `Never ${forbiddenAction}.`, 'Never send private data, prompts, outputs, weights, or adapters off-device.'], inputSchema: { type: 'object', required: ['request'], properties: { request: { type: 'string', description: input } } }, outputSchema: { type: 'object', required: ['result'], properties: { result: { type: 'string', description: output } } }, behaviorRequirements: [`Return ${output} for the supplied ${input}.`, 'State uncertainty instead of inventing evidence.'], forbiddenBehavior: [`Never ${forbiddenAction}.`, 'Do not claim to use tools, files, or services that were not supplied.', 'Do not reveal, retain, or transmit private data or secrets.'], latencyTarget: { kind: 'maximum', maxMilliseconds: draft.latencyMs }, memoryTarget: { kind: 'maximum', maxBytes: draft.memoryMb * 1024 * 1024 }, commercialIntent: draft.commercialIntent, evaluationRubric: { criteria: [{ id: 'task-fit', description: `The result satisfies: ${output}`, weight: 0.5 }, { id: 'constraint-following', description: constraints, weight: 0.5 }] }, successMetrics: [{ id: 'task-fit', name: 'Task fit', description: `Reviewed results satisfy: ${output}`, target: draft.threshold, unit: 'ratio', direction: 'at_least' }, { id: 'unsafe-output', name: 'Unsafe output', description: 'Count of outputs that violate the local-only constraint.', target: 0, unit: 'count', direction: 'at_most' }], promotionThreshold: { metricId: 'task-fit', minimumValue: draft.threshold }, regressionThreshold: { metricId: 'task-fit', maximumRegression: 0.05 }, createdAt: now, updatedAt: now };
}

export function FoundryPage({ storage = browserStorage, dependencies = defaultDependencies }: FoundryPageProps) {
  const [backend] = React.useState(() => new DeterministicFixtureBackend(dependencies));
  const plan = useAuthStore((state) => state.plan);
  const [repository] = React.useState(() => new VersionedFixtureRepository(storage, 'vibespace.model-foundry', () => dependencies.idFactory('correlation')));
  const [deployments] = React.useState(() => new FoundryDeploymentRepository(storage, dependencies.clock, () => dependencies.idFactory('deployment')));
  const [adapterRegistry] = React.useState(() => new LocalAdapterRegistry(storage, dependencies.clock));
  const [snapshot, setSnapshot] = React.useState<ProjectSnapshot | null>(null);
  const [projectCatalog, setProjectCatalog] = React.useState<readonly ProjectSnapshot[]>(() => readProjectCatalog(storage));
  const projectCatalogRef = React.useRef(projectCatalog);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [hardware, setHardware] = React.useState<FoundryHardwareProfile | null>(null);
  const [checkingHardware, setCheckingHardware] = React.useState(false);
  const [selectedModelId, setSelectedModelId] = React.useState('fixture-base');
  const [licenseApproved, setLicenseApproved] = React.useState(false);
  const [downloadStatus, setDownloadStatus] = React.useState<string | null>(null);
  const [showDatasetStudio, setShowDatasetStudio] = React.useState(false);
  const [trainingRuntime, setTrainingRuntime] = React.useState<FoundryTrainingRuntimeStatus | null>(null);
  const [runtimeApproval, setRuntimeApproval] = React.useState(false);
  const [runtimeBusy, setRuntimeBusy] = React.useState(false);
  const [nativeRun, setNativeRun] = React.useState<NativeRunState | null>(null);
  const [localAdapters, setLocalAdapters] = React.useState<readonly LocalAdapterRecord[]>([]);
  const [privateEvaluationCases, setPrivateEvaluationCases] = React.useState<readonly FoundryPrivateEvaluationCase[]>([]);
  const skipPrivateSuitePersist = React.useRef(false);
  const [deployment, setDeployment] = React.useState<FoundryDeploymentRecord | null>(null);
  const [routingMode, setRoutingMode] = React.useState<FoundryDeploymentRecord['routingMode']>('manual');
  const [trafficPercent, setTrafficPercent] = React.useState(100);
  const [feedbackConsent, setFeedbackConsent] = React.useState(false);
  const [metadataSyncEnabled, setMetadataSyncEnabled] = React.useState(() => foundryMetadataSyncEnabled(storage));
  const [metadataSyncState, setMetadataSyncState] = React.useState<'local_only' | 'queued' | 'deletion_queued'>('local_only');
  const previousMetadataSyncEnabled = React.useRef(metadataSyncEnabled);
  const [showCustomCreator, setShowCustomCreator] = React.useState(false);
  const [customDraft, setCustomDraft] = React.useState({ name: '', purpose: '', input: '', output: '', constraints: '', language: 'English', forbiddenAction: 'invent unsupported facts or actions', commercialIntent: 'personal' as SpecialistDefinition['commercialIntent'], latencyMs: 8000, memoryMb: 1024, threshold: 0.8 });
  const [realConfig, setRealConfig] = React.useState({ method: 'lora' as 'lora' | 'qlora', seed: 7, epochs: 1, batchSize: 1, gradientAccumulation: 4, maxSequenceLength: 256, learningRate: 0.0002, loraRank: 8, loraAlpha: 16, loraDropout: 0.05 });
  const projectId = snapshot?.project.id;

  const persistProjectCatalog = React.useCallback((next: readonly ProjectSnapshot[]) => {
    try { writeProjectCatalog(storage, next); } catch { /* The active repository still preserves the current project. */ }
    projectCatalogRef.current = next;
    setProjectCatalog(next);
  }, [storage]);

  React.useEffect(() => {
    const loaded = repository.load();
    if (!loaded.ok) return setError(loaded.error.message);
    if (!loaded.value) return;
    const restored = backend.restoreProject(loaded.value);
    if (restored.ok) {
      const saved = repository.save(restored.value);
      if (!saved.ok) setError(saved.error.message); else { setSnapshot(restored.value); persistProjectCatalog([restored.value, ...projectCatalogRef.current.filter((candidate) => candidate.project.id !== restored.value.project.id)]); }
    } else setError(restored.error.message);
  }, [backend, persistProjectCatalog, repository]);

  React.useEffect(() => {
    if (!projectId) return;
    const restored = readPersistedNativeRun(storage, projectId);
    setNativeRun(restored?.terminal ? restored : restored ? { ...restored, phase: 'interrupted', terminal: true, detail: 'The desktop app restarted. Resume from the last verified checkpoint.' } : null);
  }, [projectId, storage]);

  React.useEffect(() => {
    if (!projectId) { setPrivateEvaluationCases([]); return; }
    skipPrivateSuitePersist.current = true;
    setPrivateEvaluationCases(readPersistedPrivateEvaluationCases(storage, projectId));
  }, [projectId, storage]);

  React.useEffect(() => {
    setLocalAdapters(projectId ? adapterRegistry.list(projectId) : []);
  }, [adapterRegistry, projectId]);

  React.useEffect(() => {
    const rollback = (event: Event) => {
      const requestedProjectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      if (!projectId || requestedProjectId !== projectId) return;
      try { setLocalAdapters(adapterRegistry.rollback(projectId)); setNotice('Restored the immediately prior verified local champion.'); setError(null); }
      catch (caught) { setError(caught instanceof Error ? caught.message : 'Local champion rollback failed.'); }
    };
    window.addEventListener('vibespace:foundry-rollback-requested', rollback);
    return () => window.removeEventListener('vibespace:foundry-rollback-requested', rollback);
  }, [adapterRegistry, projectId]);

  React.useEffect(() => {
    if (!projectId || !nativeRun) return;
    try {
      const parsed = JSON.parse(storage.getItem(NATIVE_RUN_STORAGE_KEY) ?? '{}') as Record<string, NativeRunState>;
      storage.setItem(NATIVE_RUN_STORAGE_KEY, JSON.stringify({ ...parsed, [projectId]: nativeRun }));
    } catch { /* Local run-state persistence is optional. */ }
  }, [nativeRun, projectId, storage]);

  React.useEffect(() => {
    if (!projectId) return;
    if (skipPrivateSuitePersist.current) { skipPrivateSuitePersist.current = false; return; }
    if (privateEvaluationCases.some(privateCaseContainsCredential)) return;
    try {
      const parsed = JSON.parse(storage.getItem(PRIVATE_EVALUATION_STORAGE_KEY) ?? '{}') as Record<string, readonly FoundryPrivateEvaluationCase[]>;
      storage.setItem(PRIVATE_EVALUATION_STORAGE_KEY, JSON.stringify({ ...parsed, [projectId]: privateEvaluationCases }));
    } catch { /* Local private-suite persistence is optional. */ }
  }, [privateEvaluationCases, projectId, storage]);

  React.useEffect(() => {
    if (!snapshot) return;
    const wasEnabled = previousMetadataSyncEnabled.current;
    const canSync = metadataSyncEnabled && getPlan(plan).cloudSync;
    previousMetadataSyncEnabled.current = canSync;
    if (canSync) {
      void queueFoundryMetadataSync(snapshot, storage).then(() => setMetadataSyncState('queued')).catch(() => setError('Metadata sync could not be queued. Local data remains unchanged.'));
    } else if (wasEnabled) {
      void queueFoundryMetadataDeletion(snapshot).then(() => setMetadataSyncState('deletion_queued')).catch(() => setError('Metadata deletion could not be queued. Local data remains unchanged.'));
    } else {
      setMetadataSyncState('local_only');
    }
  }, [metadataSyncEnabled, plan, snapshot, storage]);

  React.useEffect(() => {
    const refresh = () => setMetadataSyncEnabled(foundryMetadataSyncEnabled(storage));
    window.addEventListener('vibespace:foundry-metadata-sync-changed', refresh);
    return () => window.removeEventListener('vibespace:foundry-metadata-sync-changed', refresh);
  }, [storage]);

  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenFoundryWorkerMessages((event) => {
      const message = event.message;
      const phase = typeof message.phase === 'string' ? message.phase : typeof message.state === 'string' ? message.state : 'working';
      const progress = typeof message.progress === 'number' ? message.progress : phase === 'completed' ? 1 : 0;
      const nestedError = message.error && typeof message.error === 'object' ? message.error as Record<string, unknown> : null;
      const detail = typeof message.message === 'string'
        ? message.message
        : typeof nestedError?.message === 'string'
          ? nestedError.message
          : phase.replaceAll('_', ' ');
      setNativeRun((current) => current?.jobId === event.jobId
        ? { ...current, phase, progress, detail, terminal: message.type === 'result' }
        : current);
      if (message.type === 'result' && phase === 'completed') {
        void inspectFoundryArtifact(event.projectId, event.jobId).then((artifact) => {
          const projectName = projectCatalogRef.current.find((candidate) => candidate.project.id === event.projectId)?.project.specialist.name;
          const registered = adapterRegistry.upsert(event.projectId, event.jobId, artifact, projectName);
          setLocalAdapters((current) => [...current.filter((item) => item.projectId !== registered.projectId || item.jobId !== registered.jobId), registered]);
          setNativeRun((current) => current?.jobId === event.jobId
            ? { ...current, detail: `Verified adapter artifact (${Object.keys(artifact.adapterFiles).length} files, ${artifact.manifestSha256.slice(0, 12)}…).`, terminal: true }
            : current);
        }).catch((caught) => setError(caught instanceof Error ? caught.message : 'Completed artifact verification failed.'));
      }
    }).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, [adapterRegistry]);

  const commit = React.useCallback((next: ProjectSnapshot) => {
    const saved = repository.save(next);
    if (!saved.ok) return setError(saved.error.message);
    persistProjectCatalog([next, ...projectCatalogRef.current.filter((candidate) => candidate.project.id !== next.project.id)]);
    setSnapshot(next); setError(null);
  }, [persistProjectCatalog, repository]);
  const refresh = React.useCallback((projectId: string) => commit({ ...unwrap(backend.getProject(projectId)) }), [backend, commit]);
  const act = (operation: () => void) => { try { operation() } catch (caught) { setError(caught instanceof Error ? caught.message : 'Foundry operation failed.') } };

  const activeJob = snapshot?.trainingJobs.at(-1);
  const candidate = snapshot?.modelVersions.at(-1);
  const evaluation = snapshot?.evaluationRuns.at(-1);
  const canAdvance = Boolean(activeJob && ['queued', 'preparing', 'training', 'checkpointing'].includes(activeJob.state));
  const selectedModel = FOUNDRY_MODEL_CATALOG.find((model) => model.id === selectedModelId) ?? FOUNDRY_MODEL_CATALOG[0];

  React.useEffect(() => {
    const persistedModelId = snapshot?.baseModel?.id;
    if (!persistedModelId || !FOUNDRY_MODEL_CATALOG.some((model) => model.id === persistedModelId)) return;
    setSelectedModelId(persistedModelId);
    setLicenseApproved(false);
    setDownloadStatus(null);
  }, [snapshot?.baseModel?.id, snapshot?.project.id]);

  React.useEffect(() => {
    if (!projectId) return;
    const active = deployments.list(projectId).find((item) => item.status === 'active') ?? null;
    setDeployment(active);
  }, [deployments, projectId, snapshot?.championVersionId]);

const checkHardware = async () => {
    setCheckingHardware(true);
    try { setHardware(await getFoundryHardwareProfile()); setError(null); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Hardware check failed.'); }
    finally { setCheckingHardware(false); }
  };
const downloadSelectedModel = async () => {
    if (!projectId || !selectedModel.download) return;
    setDownloadStatus('Downloading and verifying…');
    try {
      const result = await downloadFoundryModel({
        projectId,
        modelId: selectedModel.id,
        revision: selectedModel.revision,
        license: selectedModel.license,
        files: selectedModel.download.files.map((file) => ({
          path: file.path,
          url: file.url,
          expectedSha256: file.expectedSha256,
          expectedSizeBytes: file.approvedMaximumBytes,
        })),
        licenseApproved,
      });
      setDownloadStatus(`Verified ${Math.round(result.sizeBytes / 1_000_000)} MB offline model snapshot (${result.files.length} files).`);
      setError(null);
    } catch (caught) {
      setDownloadStatus(null);
      setError(caught instanceof Error ? caught.message : 'Model download failed.');
    }
  };
  const inspectTrainingRuntime = async () => {
    setRuntimeBusy(true);
    try { setTrainingRuntime(await getFoundryTrainingRuntimeStatus()); setError(null); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Training runtime check failed.'); }
    finally { setRuntimeBusy(false); }
  };
  const installTrainingRuntime = async () => {
    const includeQlora = realConfig.method === 'qlora';
    if (!runtimeApproval) return;
    setRuntimeBusy(true);
    try { setTrainingRuntime(await installFoundryTrainingDependencies(includeQlora)); setError(null); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Training runtime installation failed.'); }
    finally { setRuntimeBusy(false); }
  };
  const startRealTraining = async () => {
    if (!projectId || !snapshot?.datasetVersion || selectedModel.kind !== 'downloadable') return;
    const runtime = await getFoundryTrainingRuntimeStatus();
    setTrainingRuntime(runtime);
    if (!runtime.installed) throw new Error('Install the pinned LoRA runtime before starting real training.');
    if (realConfig.method === 'qlora' && !runtime.qloraInstalled) throw new Error('Install the optional pinned QLoRA add-on before starting a QLoRA run.');
    if (!downloadStatus?.startsWith('Verified')) throw new Error('Download and verify the complete pinned base-model snapshot first.');
    const trainExamples = snapshot.datasetVersion.examples.filter((example) => example.split === 'train').map((example) => ({ prompt: example.input, completion: example.expectedOutput }));
    const validationExamples = snapshot.datasetVersion.examples.filter((example) => example.split === 'validation').map((example) => ({ prompt: example.input, completion: example.expectedOutput }));
    if (!trainExamples.length || !validationExamples.length) throw new Error('Real training requires an approved dataset version with both train and validation examples.');
    const approved = snapshot.datasetVersion.scanSummary.status === 'passed'
      && snapshot.datasetVersion.qualitySummary.status !== 'failed'
      && snapshot.datasetVersion.licenseReport.status === 'passed'
      && snapshot.datasetVersion.secretScanReport.status === 'passed';
    if (!approved) throw new Error('The attached dataset version has not passed every approval gate.');
    const jobId = `real-${crypto.randomUUID()}`;
    setNativeRun({ jobId, phase: 'queued', progress: 0, detail: 'Submitting immutable real-training job.', terminal: false });
    try {
      await startFoundryTraining({
        projectId,
        jobId,
        modelId: selectedModel.id,
        datasetVersionId: snapshot.datasetVersion.id,
        datasetManifestHash: snapshot.datasetVersion.manifestHash,
        datasetFingerprint: snapshot.datasetVersion.fingerprint,
        datasetApproved: true,
        trainExamples,
        validationExamples,
        trainingConfig: realConfig,
      });
    } catch (caught) {
      setNativeRun((current) => current?.jobId === jobId ? { ...current, phase: 'failed', terminal: true, detail: caught instanceof Error ? caught.message : 'Could not start real training.' } : current);
      throw caught;
    }
  };
  const cancelRealTraining = async () => {
    if (!projectId || !nativeRun || nativeRun.terminal) return;
    const accepted = await cancelFoundryTraining(projectId, nativeRun.jobId);
    if (!accepted) throw new Error('The real-training worker is no longer active.');
    setNativeRun((current) => current ? { ...current, detail: 'Cancellation requested; the worker will stop safely.' } : current);
  };
  const resumeRealTraining = async () => {
    if (!projectId || !nativeRun || nativeRun.phase !== 'interrupted') return;
    setNativeRun((current) => current ? { ...current, phase: 'resuming', progress: current.progress, terminal: false, detail: 'Verifying the last checkpoint before resuming.' } : current);
    try {
      await resumeFoundryTraining(projectId, nativeRun.jobId);
    } catch (caught) {
      setNativeRun((current) => current ? { ...current, phase: 'interrupted', terminal: true, detail: caught instanceof Error ? caught.message : 'Could not resume real training.' } : current);
      throw caught;
    }
  };
  const stopRealTrainingAfterCheckpoint = async () => {
    if (!projectId || !nativeRun || nativeRun.terminal) return;
    const accepted = await stopFoundryTrainingAfterCheckpoint(projectId, nativeRun.jobId);
    if (!accepted) throw new Error('The real-training worker is no longer active.');
    setNativeRun((current) => current ? { ...current, detail: 'Will stop after the next verified checkpoint.' } : current);
  };
  const useRegisteredAdapterInChat = (record: LocalAdapterRecord) => {
    if (record.status !== 'promoted') throw new Error('Only the explicitly promoted local adapter can be selected for chat.');
    useAuthStore.getState().setChatModelSelection({ mode: 'single', providerId: 'foundry', modelId: `${record.projectId}--${record.jobId}` });
    setNotice(`Selected ${record.projectName?.trim() || record.jobId} as the local chat champion.`); setError(null);
  };
  const archiveRegisteredAdapter = (record: LocalAdapterRecord) => act(() => setLocalAdapters(adapterRegistry.archive(record.projectId, record.jobId)));
  const probeRegisteredAdapter = async (record: LocalAdapterRecord) => { const result = await generateFromFoundryArtifact({ projectId: record.projectId, jobId: record.jobId, prompt: 'Reply READY.', maxNewTokens: 8 }); setNotice(`Adapter probe succeeded: ${result.text.slice(0, 80)}`); setError(null); };
  const evaluateRegisteredAdapter = async (record: LocalAdapterRecord) => {
    if (privateEvaluationCases.some((evaluationCase) => !evaluationCase.prompt.trim() || !evaluationCase.expectedCompletion.trim())) throw new Error('Complete or remove every private evaluation case before running it.');
    if (privateEvaluationCases.some(privateCaseContainsCredential)) throw new Error('Remove credential-shaped text from private evaluation cases before running them.');
    const champion = localAdapters.find((adapter) => adapter.status === 'promoted' && adapter.jobId !== record.jobId);
    const result = await evaluateFoundryArtifact({ projectId: record.projectId, jobId: record.jobId, championJobId: champion?.jobId, ...(privateEvaluationCases.length ? { maxCases: privateEvaluationCases.length, cases: privateEvaluationCases } : {}) });
    setLocalAdapters(adapterRegistry.recordEvaluation(record.projectId, record.jobId, result.artifactManifestSha256, result.report));
    const benchmark = result.report.championScore === null ? 'base' : 'base and current champion';
    setNotice(result.report.gate === 'pass' ? `Evaluation passed: ${result.report.candidateScore.toFixed(3)} candidate score (${result.report.delta >= 0 ? '+' : ''}${result.report.delta.toFixed(3)} versus base; compared with ${benchmark}). Explicit approval is still required.` : `Evaluation blocked promotion: ${result.report.candidateScore.toFixed(3)} candidate score (${result.report.delta.toFixed(3)} versus base), ${result.report.safetyFailures.length} safety failure(s).`);
    setError(null);
  };
  const promoteRegisteredAdapter = (record: LocalAdapterRecord) => { setLocalAdapters(adapterRegistry.promote(record.projectId, record.jobId)); setNotice(`${record.jobId} is now the promoted local champion. Earlier champions remain available for rollback.`); setError(null); };
  const activateDeployment = () => act(() => {
    if (!projectId || !snapshot?.championVersionId) return;
    const champion = snapshot.modelVersions.find((version) => version.id === snapshot.championVersionId);
    if (!champion) throw new Error('The champion artifact is unavailable for deployment.');
    setDeployment(deployments.activate({ projectId, modelVersionId: champion.id, artifactFingerprint: champion.artifactFingerprint, routingMode, trafficPercent }));
  });
  const pauseDeployment = () => act(() => {
    if (!projectId || !deployment) return;
    setDeployment(deployments.pause(projectId, deployment.id));
  });
  const recordFeedback = (rating: 'helpful' | 'not_helpful') => act(() => {
    if (!projectId || !feedbackConsent) return;
    const evidenceHash = evaluation?.caseEvidence[0]?.evidenceHash ?? candidate?.artifactFingerprint;
    if (!evidenceHash) throw new Error('Run an evaluation before recording improvement feedback.');
    unwrap(backend.recordFeedback(projectId, { rating, evidenceHash, consent: { approved: true, actorId: 'local-owner', approvedAt: dependencies.clock(), purpose: 'Improve this local specialist from reviewed feedback.' } }));
    refresh(projectId);
  });
  const createImprovementCycle = () => act(() => {
    if (!projectId || !snapshot?.feedbackEvents.length) return;
    unwrap(backend.createImprovementCycle(projectId, snapshot.feedbackEvents.map((event) => event.id), 'local-owner', 'Consented local feedback is ready for a governed training review.'));
    refresh(projectId);
  });
  const createProject = (specialist: SpecialistDefinition = VIBECODER_TEMPLATE) => act(() => commit(unwrap(backend.createProject(specialist))));
  const createCustomProject = () => act(() => createProject(customSpecialist(customDraft, dependencies.clock())));
  const openCatalogProject = (catalogSnapshot: ProjectSnapshot) => act(() => commit(unwrap(backend.restoreProject(catalogSnapshot))));
  const createAnotherProject = () => { setSnapshot(null); setShowCustomCreator(false); setShowDatasetStudio(false); setNativeRun(null); setSelectedModelId('fixture-base'); setLicenseApproved(false); setDownloadStatus(null); setPrivateEvaluationCases([]); setError(null); setNotice('Create a new specialist. Existing local projects remain available below.'); };
  const prepare = () => act(() => { if (!projectId || !snapshot) return; unwrap(backend.attachBaseModel(projectId, createFixtureBase(dependencies.clock()))); commit(unwrap(backend.attachDatasetVersion(projectId, createFixtureDataset(projectId, dependencies.clock(), snapshot.project.specialist)))) });
  const attachStudioDataset = (dataset: Parameters<DeterministicFixtureBackend['attachDatasetVersion']>[1]) => act(() => { if (!projectId) return; unwrap(backend.attachBaseModel(projectId, createFixtureBase(dependencies.clock()))); commit(unwrap(backend.attachDatasetVersion(projectId, dataset))); setShowDatasetStudio(false); });
  const startTraining = () => act(() => { if (!projectId) return; unwrap(backend.startTraining(projectId, { method: 'lora', config: { epochs: 1, learningRate: 0.0002, rank: 8, seed: 7, batchSize: 1, gradientAccumulationSteps: 1, sequenceLength: 256, validationSplit: 0.1 } })); refresh(projectId) });
  const advance = () => act(() => { if (!projectId || !activeJob) return; unwrap(backend.advanceTraining(projectId, activeJob.id)); refresh(projectId) });
  const resume = () => act(() => { if (!projectId || !activeJob) return; unwrap(backend.resumeTraining(projectId, activeJob.id)); refresh(projectId) });
  const evaluate = () => act(() => { if (!projectId || !candidate || !snapshot) return; unwrap(backend.evaluateCandidate(projectId, candidate.id, createFixtureEvaluation(dependencies.clock(), snapshot.project.specialist))); refresh(projectId) });
  const promote = () => act(() => { if (!projectId || !candidate || !evaluation) return; unwrap(backend.promoteCandidate(projectId, candidate.id, evaluation.id, 'local-owner', 'Passed every fixture promotion gate.')); refresh(projectId) });
  const nextAction = !snapshot?.datasetVersion ? 'Add an approved dataset' : !activeJob ? 'Start a governed training run' : activeJob.state !== 'completed' ? 'Monitor or recover the active training run' : !evaluation ? 'Run the evaluation gates' : !snapshot.championVersionId ? 'Review and explicitly promote the candidate' : 'Use the promoted local model in chat';

  return <main className="h-full overflow-y-auto bg-[radial-gradient(circle_at_top_right,hsl(var(--accent-violet)/0.10),transparent_42%)] p-5 md:p-7">
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between"><div><div className="mb-2 flex items-center gap-2 text-metadata uppercase tracking-[0.18em] text-cyan-400"><FlaskConical className="h-4 w-4" /> Model Foundry</div><h1 className="text-2xl font-semibold tracking-tight">Build Your Own AI</h1><p className="mt-1 max-w-2xl text-secondary text-muted-foreground">Define a focused specialist, prepare approved local data, and earn promotion through measured gates.</p></div><Badge variant="outline" className={cn('w-fit', selectedModel.kind === 'fixture' ? 'border-amber-500/30 text-amber-300' : 'border-cyan-500/30 text-cyan-200')}>{selectedModel.kind === 'fixture' ? 'Fixture mode · local only' : 'Real local mode · setup required'}</Badge></header>
      {selectedModel.kind === 'fixture' && <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-secondary text-amber-100"><strong>Truthful simulation:</strong> fixture mode never trains weights. It exercises lifecycle, recovery, evaluation, and promotion contracts locally.</div>}
      {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-destructive">{error}</div>}
      {notice && <div role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-emerald-200">{notice}</div>}
      {!snapshot && showCustomCreator && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-violet-500/20 bg-violet-500/5 p-3"><span className="mr-1 text-metadata text-muted-foreground">Safe templates</span>{SPECIALIST_TEMPLATES.map((template) => <Button key={template.label} variant="outline" onClick={() => setCustomDraft((value) => ({ ...value, ...template }))}>{template.label}</Button>)}</div>}
      {!snapshot && showCustomCreator && <div className="grid gap-3 rounded-lg border border-border bg-background/35 p-3 md:grid-cols-2"><label className="space-y-1"><span className="text-metadata text-muted-foreground">Output language</span><input value={customDraft.language} maxLength={80} onChange={(event) => setCustomDraft((value) => ({ ...value, language: event.target.value }))} className="h-9 w-full rounded-md border border-input bg-background px-3" /></label><label className="space-y-1"><span className="text-metadata text-muted-foreground">Forbidden action</span><input value={customDraft.forbiddenAction} maxLength={200} onChange={(event) => setCustomDraft((value) => ({ ...value, forbiddenAction: event.target.value }))} className="h-9 w-full rounded-md border border-input bg-background px-3" /></label><p className="md:col-span-2 text-metadata text-muted-foreground">Current local specialist templates have no tool permissions. Any required tool must be supplied as input evidence; the model cannot claim it ran a tool.</p></div>}
      {!snapshot ? <Card className="overflow-hidden border-cyan-500/20 bg-panel/90"><CardHeader className="border-b border-border bg-gradient-to-r from-cyan-500/10 to-violet-500/10"><CardTitle className="flex items-center gap-2 text-lg"><Sparkles className="text-cyan-400" /> {showCustomCreator ? 'Create a focused specialist' : 'Start with VibeCoder'}</CardTitle><CardDescription>{showCustomCreator ? 'Describe one narrow, measurable task. The project remains local-only and starts with no tool permissions.' : 'A narrow coding-review specialist with local-only privacy, no tool access, and explicit evidence rules.'}</CardDescription></CardHeader><CardContent className="grid gap-3 pt-4 md:grid-cols-3">{showCustomCreator ? <><label className="space-y-1 md:col-span-2"><span className="text-metadata text-muted-foreground">Specialist name</span><input value={customDraft.name} maxLength={80} onChange={(event) => setCustomDraft((value) => ({ ...value, name: event.target.value }))} placeholder="Invoice extractor" className="h-9 w-full rounded-md border border-input bg-background px-3" /></label><label className="space-y-1"><span className="text-metadata text-muted-foreground">Narrow task</span><input value={customDraft.purpose} maxLength={300} onChange={(event) => setCustomDraft((value) => ({ ...value, purpose: event.target.value }))} placeholder="Extract invoice totals" className="h-9 w-full rounded-md border border-input bg-background px-3" /></label><label className="space-y-1"><span className="text-metadata text-muted-foreground">Expected input</span><input value={customDraft.input} maxLength={300} onChange={(event) => setCustomDraft((value) => ({ ...value, input: event.target.value }))} placeholder="A local invoice document" className="h-9 w-full rounded-md border border-input bg-background px-3" /></label><label className="space-y-1"><span className="text-metadata text-muted-foreground">Expected output</span><input value={customDraft.output} maxLength={300} onChange={(event) => setCustomDraft((value) => ({ ...value, output: event.target.value }))} placeholder="Validated total fields" className="h-9 w-full rounded-md border border-input bg-background px-3" /></label><label className="space-y-1 md:col-span-3"><span className="text-metadata text-muted-foreground">Hard constraint</span><input value={customDraft.constraints} maxLength={300} onChange={(event) => setCustomDraft((value) => ({ ...value, constraints: event.target.value }))} placeholder="Only extract fields present in the supplied document." className="h-9 w-full rounded-md border border-input bg-background px-3" /></label><label className="space-y-1"><span className="text-metadata text-muted-foreground">Passing score</span><input type="number" min={0.01} max={1} step={0.01} value={customDraft.threshold} onChange={(event) => setCustomDraft((value) => ({ ...value, threshold: Number(event.target.value) }))} className="h-9 w-full rounded-md border border-input bg-background px-3" /></label><label className="space-y-1"><span className="text-metadata text-muted-foreground">Latency budget (ms)</span><input type="number" min={100} max={120000} step={100} value={customDraft.latencyMs} onChange={(event) => setCustomDraft((value) => ({ ...value, latencyMs: Number(event.target.value) }))} className="h-9 w-full rounded-md border border-input bg-background px-3" /></label><label className="space-y-1"><span className="text-metadata text-muted-foreground">Memory budget (MB)</span><input type="number" min={64} max={131072} step={64} value={customDraft.memoryMb} onChange={(event) => setCustomDraft((value) => ({ ...value, memoryMb: Number(event.target.value) }))} className="h-9 w-full rounded-md border border-input bg-background px-3" /></label><label className="space-y-1"><span className="text-metadata text-muted-foreground">Intended use</span><select value={customDraft.commercialIntent} onChange={(event) => setCustomDraft((value) => ({ ...value, commercialIntent: event.target.value as SpecialistDefinition['commercialIntent'] }))} className="h-9 w-full rounded-md border border-input bg-background px-3"><option value="personal">Personal</option><option value="commercial">Commercial</option><option value="research">Research</option></select></label><p className="md:col-span-3 text-metadata text-muted-foreground">Broad goals are intentionally not accepted as a specialist. You can refine data, evaluation, and promotion after creation.</p><Button variant="outline" onClick={() => setShowCustomCreator(false)}>Use VibeCoder template</Button><Button variant="accent" className="md:col-span-2" onClick={createCustomProject}>Create custom AI <ArrowRight /></Button></> : <><StepCard icon={<ShieldCheck className="h-4 w-4" />} title="Constrained" detail="No shell, network, or external transfer." complete={false} /><StepCard icon={<Database className="h-4 w-4" />} title="Traceable" detail="Versioned data and approval provenance." complete={false} /><StepCard icon={<Cpu className="h-4 w-4" />} title="Measurable" detail="Quality, safety, and regression gates." complete={false} /><Button variant="outline" className="mt-2" onClick={() => setShowCustomCreator(true)}>Create custom AI</Button><Button variant="accent" className="mt-2 md:col-span-2" onClick={() => createProject()}>Create VibeCoder <ArrowRight /></Button></>}</CardContent></Card> : <>
        <Card className="border-violet-500/20 bg-panel/90"><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle><h2 className="text-xl">{snapshot.project.specialist.name}</h2></CardTitle><CardDescription>{snapshot.project.specialist.purpose}</CardDescription></div><Badge variant="outline" className="border-emerald-500/30 text-emerald-300">Project ready</Badge></div></CardHeader><CardContent className="grid gap-3 md:grid-cols-4"><StepCard icon={<Sparkles className="h-4 w-4" />} title="Specialist" detail="Objective and constraints locked." complete /><StepCard icon={<Database className="h-4 w-4" />} title="Data" detail={snapshot.datasetVersion ? 'Approved manifest attached.' : 'Awaiting approved inputs.'} complete={Boolean(snapshot.datasetVersion)} /><StepCard icon={<Cpu className="h-4 w-4" />} title="Training" detail={activeJob ? titleCase(activeJob.state) : 'Not started.'} complete={activeJob?.state === 'completed'} /><StepCard icon={<ShieldCheck className="h-4 w-4" />} title="Promotion" detail={snapshot.championVersionId ? 'Champion selected.' : 'Requires passing evidence.'} complete={Boolean(snapshot.championVersionId)} /></CardContent></Card>
        <Card className="border-cyan-500/15"><CardContent className="grid gap-3 pt-4 sm:grid-cols-2 lg:grid-cols-4"><OverviewStat label="Next action" value={nextAction} /><OverviewStat label="Dataset health" value={snapshot.datasetVersion ? `${snapshot.datasetVersion.scanSummary.status} · ${snapshot.datasetVersion.examples.length} reviewed` : 'No approved version'} /><OverviewStat label="Local privacy" value="Raw inputs, outputs, weights, and logs stay on this device" /><OverviewStat label="Plan & sync" value={`${getPlan(plan).label} · ${metadataSyncState === 'queued' ? 'metadata sync queued (hashes only)' : metadataSyncState === 'deletion_queued' ? 'cloud deletion queued' : getPlan(plan).cloudSync ? 'metadata sync optional' : 'local Foundry unrestricted'}`} /></CardContent></Card>
<Card className="border-cyan-500/20"><CardContent className="flex flex-wrap items-center justify-between gap-4 pt-4"><div className="flex items-start gap-3"><Gauge className="mt-0.5 h-5 w-5 text-cyan-400" /><div><div className="text-ui-strong">Device readiness</div>{hardware ? <><div className="text-secondary text-muted-foreground">{hardware.native ? `${hardware.os} · ${hardware.architecture} · ${hardware.logicalCores} logical cores` : hardware.acceleratorDetail}</div><div className="mt-1 text-metadata text-amber-200">Recommendation: {hardware.recommendedMode.replaceAll('_', ' ')}</div></> : <div className="text-secondary text-muted-foreground">Run an honest local check before choosing real training.</div>}</div></div><Button onClick={() => void checkHardware()} disabled={checkingHardware}>{checkingHardware ? 'Checking device…' : 'Check this device'}</Button></CardContent></Card>
<Card className="border-violet-500/20"><CardHeader><CardTitle>Real training runtime</CardTitle><CardDescription>The fixture worker is lightweight. Real LoRA uses a separate, hash-pinned Python environment and is installed only after approval.</CardDescription></CardHeader><CardContent className="space-y-3"><div className="text-secondary text-muted-foreground">{trainingRuntime?.detail ?? 'Not checked on this device.'}</div>{!trainingRuntime?.installed && <label className="flex items-start gap-2 text-secondary"><input type="checkbox" checked={runtimeApproval} onChange={(event) => setRuntimeApproval(event.target.checked)} className="mt-0.5" /><span>I approve installing the pinned real-training stack. This can be a multi-gigabyte download; it stays inside VibeSpace app data and does not modify global Python.</span></label>}<div className="flex flex-wrap gap-2"><Button variant="outline" disabled={runtimeBusy} onClick={() => void inspectTrainingRuntime()}>{runtimeBusy ? 'Working…' : 'Check training runtime'}</Button>{!trainingRuntime?.installed && <Button variant="accent" disabled={!runtimeApproval || runtimeBusy} onClick={() => void installTrainingRuntime()}>Install pinned LoRA runtime</Button>}</div><p className="text-metadata text-muted-foreground">No dependency install starts automatically. QLoRA remains disabled unless CUDA and the optional pinned quantization runtime are both verified.</p></CardContent></Card><Card><CardHeader><CardTitle>Approved base models</CardTitle><CardDescription>Review source, immutable revision, license, size, and local resource estimate before selection.</CardDescription></CardHeader><CardContent className="space-y-3">{FOUNDRY_MODEL_CATALOG.map((model) => { const compatibility = modelCompatibility(model, hardware?.ramBytes ?? null); const selected = model.id === selectedModel.id; return <button key={model.id} type="button" aria-pressed={selected} onClick={() => { setSelectedModelId(model.id); setLicenseApproved(false); setDownloadStatus(null); }} className={cn('w-full rounded-lg border p-3 text-left transition-colors', selected ? 'border-cyan-400/50 bg-cyan-500/5' : 'border-border hover:bg-muted/40')}><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-ui-strong">{model.name}</span><div className="flex gap-2"><Badge variant="outline">{model.license}</Badge><Badge variant="outline">{compatibility}</Badge></div></div><div className="mt-1 text-metadata text-muted-foreground">{model.publisher} · {model.displaySize} · {model.parameterCount.toLocaleString()} parameters · {model.format}</div><div className="mt-1 truncate text-metadata text-muted-foreground">Revision {model.revision}</div></button>; })}{selectedModel.kind === 'fixture' ? <div className="text-secondary text-emerald-300">Bundled fixture metadata selected. No model download is required.</div> : <div className="space-y-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3"><label className="flex items-start gap-2 text-secondary"><input type="checkbox" checked={licenseApproved} onChange={(event) => setLicenseApproved(event.target.checked)} className="mt-0.5" /><span>I reviewed and approve the {selectedModel.license} license and the {selectedModel.displaySize} verified download.</span></label><div className="flex flex-wrap items-center gap-3"><Button variant="accent" disabled={!licenseApproved || Boolean(downloadStatus?.startsWith('Downloading'))} onClick={() => void downloadSelectedModel()}>Download and verify model</Button>{downloadStatus && <span className="text-metadata text-muted-foreground">{downloadStatus}</span>}</div><p className="text-metadata text-muted-foreground">Remote model code stays disabled. Only the six pinned, checksum-verified snapshot files are accepted.</p></div>}</CardContent></Card>
{(!snapshot.datasetVersion || showDatasetStudio) && <div className="space-y-3"><div className="flex flex-wrap gap-2">{!snapshot.datasetVersion && selectedModel.kind === 'fixture' && <Button variant="accent" onClick={prepare}>Prepare approved fixture inputs</Button>}<Button variant="outline" onClick={() => setShowDatasetStudio((visible) => !visible)}>{showDatasetStudio ? 'Close Dataset Studio' : snapshot.datasetVersion ? 'Create next dataset version' : 'Open Dataset Studio'}</Button></div>{showDatasetStudio && projectId && <DatasetStudioPanel projectId={projectId} now={dependencies.clock} version={snapshot.datasetVersion ? snapshot.datasetVersion.version + 1 : 1} parentVersionId={snapshot.datasetVersion?.id ?? null} onVersion={attachStudioDataset} />}</div>}
{snapshot.datasetVersion && !showDatasetStudio && <Button variant="outline" onClick={() => setShowDatasetStudio(true)}>Create next dataset version</Button>}
        {snapshot.datasetVersion && selectedModel.kind === 'downloadable' && <Card className="border-cyan-500/20"><CardHeader><CardTitle>Training Lab</CardTitle><CardDescription>Build a bounded LoRA or QLoRA run from immutable local inputs. The worker refuses to silently change these settings.</CardDescription></CardHeader><CardContent className="space-y-4"><div className="grid gap-3 md:grid-cols-3"><label className="space-y-1"><span className="text-metadata text-muted-foreground">Method</span><select value={realConfig.method} onChange={(event) => setRealConfig((config) => ({ ...config, method: event.target.value as 'lora' | 'qlora' }))} className="h-9 w-full rounded-md border border-input bg-background px-3"><option value="lora">LoRA</option><option value="qlora">QLoRA (verified CUDA only)</option></select></label><label className="space-y-1"><span className="text-metadata text-muted-foreground">Epochs</span><input type="number" min={1} max={50} value={realConfig.epochs} onChange={(event) => setRealConfig((config) => ({ ...config, epochs: Number(event.target.value) }))} className="h-9 w-full rounded-md border border-input bg-background px-3" /></label><label className="space-y-1"><span className="text-metadata text-muted-foreground">Batch size</span><input type="number" min={1} max={64} value={realConfig.batchSize} onChange={(event) => setRealConfig((config) => ({ ...config, batchSize: Number(event.target.value) }))} className="h-9 w-full rounded-md border border-input bg-background px-3" /></label><label className="space-y-1"><span className="text-metadata text-muted-foreground">Gradient accumulation</span><input type="number" min={1} max={1024} value={realConfig.gradientAccumulation} onChange={(event) => setRealConfig((config) => ({ ...config, gradientAccumulation: Number(event.target.value) }))} className="h-9 w-full rounded-md border border-input bg-background px-3" /></label><label className="space-y-1"><span className="text-metadata text-muted-foreground">Sequence length</span><input type="number" min={64} max={32768} step={64} value={realConfig.maxSequenceLength} onChange={(event) => setRealConfig((config) => ({ ...config, maxSequenceLength: Number(event.target.value) }))} className="h-9 w-full rounded-md border border-input bg-background px-3" /></label><label className="space-y-1"><span className="text-metadata text-muted-foreground">LoRA rank</span><input type="number" min={1} max={512} value={realConfig.loraRank} onChange={(event) => setRealConfig((config) => ({ ...config, loraRank: Number(event.target.value), loraAlpha: Math.max(config.loraAlpha, Number(event.target.value) * 2) }))} className="h-9 w-full rounded-md border border-input bg-background px-3" /></label><label className="space-y-1"><span className="text-metadata text-muted-foreground">Learning rate</span><input type="number" min={0.000001} max={1} step={0.0001} value={realConfig.learningRate} onChange={(event) => setRealConfig((config) => ({ ...config, learningRate: Number(event.target.value) }))} className="h-9 w-full rounded-md border border-input bg-background px-3" /></label></div><div className="text-secondary text-muted-foreground">{nativeRun ? nativeRun.detail : 'Requires the verified model snapshot, installed pinned runtime, and an approved dataset with train and validation splits.'}</div>{nativeRun && <><div className="flex items-center justify-between text-metadata text-muted-foreground"><span>{titleCase(nativeRun.phase.replaceAll('_', ' '))}</span><span>{Math.round(nativeRun.progress * 100)}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-gradient-to-r from-cyan-400 to-violet-500" style={{ width: `${nativeRun.progress * 100}%` }} /></div></>}<div className="flex flex-wrap gap-2"><Button variant="accent" disabled={Boolean(nativeRun && !nativeRun.terminal)} onClick={() => void startRealTraining().catch((caught) => setError(caught instanceof Error ? caught.message : 'Real training could not start.'))}>Start real training</Button>{nativeRun?.phase === 'interrupted' && <Button variant="accent" onClick={() => void resumeRealTraining().catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not resume real training.'))}>Resume real run</Button>}{nativeRun && !nativeRun.terminal && <><Button variant="outline" onClick={() => void stopRealTrainingAfterCheckpoint().catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not stop after checkpoint.'))}>Stop after checkpoint</Button><Button variant="outline" onClick={() => void cancelRealTraining().catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not cancel training.'))}>Cancel real run</Button></>}</div><p className="text-metadata text-muted-foreground">QLoRA fails closed without verified CUDA and pinned bitsandbytes. Out-of-memory errors preserve this configuration and return concrete reductions to try.</p></CardContent></Card>}
        {snapshot.datasetVersion && selectedModel.kind === 'fixture' && !activeJob && <Card><CardContent className="flex flex-wrap items-center justify-between gap-3 pt-4"><div><div className="text-ui-strong">{snapshot.datasetVersion.examples.length} approved {snapshot.datasetVersion.examples.length === 1 ? 'example' : 'examples'}</div><div className="text-secondary text-muted-foreground">Fixture Base · Apache-2.0</div></div><Button onClick={startTraining}>Start fixture training</Button></CardContent></Card>}
        {nativeRun?.phase === 'completed' && nativeRun.detail.startsWith('Verified adapter artifact') && selectedModel.kind === 'downloadable' && <Card className="border-emerald-500/25"><CardHeader><CardTitle>Verified local adapter</CardTitle><CardDescription>The adapter is checksum-verified and registered as a candidate. Run its local evaluation, then explicitly approve it before it can route chat.</CardDescription></CardHeader><CardContent><div className="text-metadata text-muted-foreground">Candidate ID: {projectId}--{nativeRun.jobId}</div></CardContent></Card>}
        <PrivateEvaluationSuite cases={privateEvaluationCases} onChange={setPrivateEvaluationCases} />
        {privateEvaluationCases.length > 0 && <Button variant="outline" onClick={() => setPrivateEvaluationCases([])}>Clear private evaluation suite</Button>}
        <RealAdapterRegistryPanel records={localAdapters} runtimeReady={Boolean(trainingRuntime?.installed)} onUse={useRegisteredAdapterInChat} onProbe={(record) => void probeRegisteredAdapter(record).catch((caught) => setError(caught instanceof Error ? caught.message : 'Adapter probe failed.'))} onEvaluate={(record) => void evaluateRegisteredAdapter(record).catch((caught) => setError(caught instanceof Error ? caught.message : 'Adapter evaluation failed.'))} onPromote={(record) => act(() => promoteRegisteredAdapter(record))} onArchive={archiveRegisteredAdapter} />
        {activeJob && <TrainingRegion job={activeJob} active={canAdvance} onAdvance={advance} onResume={resume} />}
        {evaluation && <div role="status" className="sr-only"><span>{evaluation.gate.result === 'pass' ? 'All gates passed' : 'Evaluation gates are blocked'}</span><span>{evaluation.safetyFailures.length} safety failures</span></div>}
        {activeJob?.state === 'completed' && candidate && <EvaluationArenaPanel candidate={candidate} evaluation={evaluation} championVersionId={snapshot.championVersionId} onEvaluate={evaluate} onPromote={promote} />}
        {activeJob?.state === 'completed' && <FixtureEvaluationEvidencePanel evaluation={evaluation} />}
        <DeploymentPanel snapshot={snapshot} deployment={deployment} routingMode={routingMode} trafficPercent={trafficPercent} onRoutingMode={setRoutingMode} onTrafficPercent={setTrafficPercent} onActivate={activateDeployment} onPause={pauseDeployment} />
        <ImprovementPanel feedbackCount={snapshot.feedbackEvents.length} cycleCount={snapshot.improvementCycles.length} consentApproved={feedbackConsent} onConsent={setFeedbackConsent} onFeedback={recordFeedback} onCycle={createImprovementCycle} />
        <LocalStateFootprint snapshot={snapshot} projectCount={projectCatalog.length} />
        <ProjectCatalogPanel projects={projectCatalog} activeProjectId={projectId} onOpen={openCatalogProject} onCreate={createAnotherProject} />
      </>}
      {!snapshot && projectCatalog.length > 0 && <ProjectCatalogPanel projects={projectCatalog} onOpen={openCatalogProject} onCreate={createAnotherProject} />}
    </div>
  </main>;
}

function TrainingRegion({ job, active, onAdvance, onResume }: { job: TrainingJobSnapshot; active: boolean; onAdvance: () => void; onResume: () => void }) {
  return <Card role="region" aria-label="Training job" className="border-cyan-500/20"><CardContent className="pt-4"><div className="flex items-center justify-between gap-3"><div><div className="text-ui-strong">{titleCase(job.state)}</div><div className="text-secondary text-muted-foreground">{Math.round(job.progress * 100)}% · deterministic fixture worker</div></div>{active && <Button onClick={onAdvance}>Advance fixture job</Button>}{job.state === 'interrupted' && <Button onClick={onResume}>Resume fixture job</Button>}</div><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-gradient-to-r from-cyan-400 to-violet-500" style={{ width: `${job.progress * 100}%` }} /></div>{job.state === 'completed' && <p className="mt-3 text-metadata text-amber-200">Fixture completed: no model training or GPU work occurred.</p>}</CardContent></Card>;
}

function PrivateEvaluationSuite({ cases, onChange }: { cases: readonly FoundryPrivateEvaluationCase[]; onChange: (cases: readonly FoundryPrivateEvaluationCase[]) => void }) {
  const addCase = () => onChange([...cases, { id: `local-case-${crypto.randomUUID()}`, prompt: '', expectedCompletion: '', hidden: true }]);
  const update = (id: string, patch: Partial<FoundryPrivateEvaluationCase>) => onChange(cases.map((evaluationCase) => evaluationCase.id === id ? { ...evaluationCase, ...patch } : evaluationCase));
  const containsCredential = cases.some(privateCaseContainsCredential);
  return <Card className="border-violet-500/20"><CardHeader><CardTitle>Private Evaluation Suite</CardTitle><CardDescription>Optional local reference cases replace the validation split for real-adapter evaluation. They are never synchronized or shown in evidence reports.</CardDescription></CardHeader><CardContent className="space-y-3">{cases.map((evaluationCase, index) => <div key={evaluationCase.id} className="grid gap-2 rounded-lg border p-3 md:grid-cols-2"><label className="space-y-1"><span className="text-metadata text-muted-foreground">Case {index + 1} prompt</span><textarea value={evaluationCase.prompt} maxLength={16384} onChange={(event) => update(evaluationCase.id, { prompt: event.target.value })} className="min-h-20 w-full rounded-md border border-input bg-background p-2 text-secondary" /></label><label className="space-y-1"><span className="text-metadata text-muted-foreground">Expected completion</span><textarea value={evaluationCase.expectedCompletion} maxLength={12000} onChange={(event) => update(evaluationCase.id, { expectedCompletion: event.target.value })} className="min-h-20 w-full rounded-md border border-input bg-background p-2 text-secondary" /></label><label className="flex items-center gap-2 text-metadata text-muted-foreground"><input type="checkbox" checked={evaluationCase.hidden} onChange={(event) => update(evaluationCase.id, { hidden: event.target.checked })} />Keep this case hidden in evaluation reports</label><Button variant="outline" className="w-fit" onClick={() => onChange(cases.filter((candidate) => candidate.id !== evaluationCase.id))}>Remove case</Button></div>)}{containsCredential && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-metadata text-destructive">Credential-shaped text is blocked and will not be stored or evaluated.</p>}<div className="flex flex-wrap items-center gap-3"><Button variant="outline" disabled={cases.length >= 32} onClick={addCase}>Add private case</Button><span className="text-metadata text-muted-foreground">{cases.length ? `${cases.length} local case${cases.length === 1 ? '' : 's'} will be used on the next real evaluation.` : 'Without local cases, the immutable validation split is used.'}</span></div></CardContent></Card>;
}

function ProjectCatalogPanel({ projects, activeProjectId, onOpen, onCreate }: { projects: readonly ProjectSnapshot[]; activeProjectId?: string; onOpen: (snapshot: ProjectSnapshot) => void; onCreate: () => void }) {
  const visibleProjects = projects.filter((project) => project?.project?.id && project?.project?.specialist?.name).sort((left, right) => right.project.updatedAt.localeCompare(left.project.updatedAt));
  return <Card className="border-cyan-500/20"><CardHeader><CardTitle>Local specialist projects</CardTitle><CardDescription>Projects are stored locally and can be reopened without replacing another specialist.</CardDescription></CardHeader><CardContent className="space-y-3"><div className="flex flex-wrap gap-2"><Button variant="accent" onClick={onCreate}>Create another AI</Button></div>{visibleProjects.length > 0 && <div className="grid gap-2 md:grid-cols-2">{visibleProjects.map((project) => <button key={project.project.id} type="button" aria-pressed={project.project.id === activeProjectId} onClick={() => onOpen(project)} className={cn('rounded-lg border p-3 text-left transition-colors', project.project.id === activeProjectId ? 'border-cyan-400/50 bg-cyan-500/5' : 'border-border hover:bg-muted/40')}><div className="text-ui-strong">{project.project.specialist.name}</div><div className="mt-1 text-metadata text-muted-foreground">{project.project.specialist.purpose}</div><div className="mt-2 text-metadata text-muted-foreground">{project.championVersionId ? 'Champion promoted' : project.trainingJobs.at(-1)?.state ?? 'Created'} · {new Date(project.project.updatedAt).toLocaleDateString()}</div></button>)}</div>}</CardContent></Card>;
}

function LocalStateFootprint({ snapshot, projectCount }: { snapshot: ProjectSnapshot; projectCount: number }) {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  const size = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
  return <div className="rounded-lg border border-border bg-background/35 px-3 py-2 text-metadata text-muted-foreground">Local Foundry state: <span className="text-ui-strong text-foreground">{size}</span> for this project · {projectCount} saved specialist{projectCount === 1 ? '' : 's'} · excludes model snapshots, adapters, checkpoints, and logs.</div>;
}
