import * as React from 'react';
import { Cpu, Database, FlaskConical, HardDrive, Sparkles, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  classifySource,
  compatibleModels,
  formatFoundryStorageBytes,
  foundryModelOptions,
  isModelInstalled,
  loadJobs,
  mayStartTraining,
  modelFoundryMethodAvailability,
  newlyCompletedJobId,
  planLocalTrainingMethod,
  saveJobs,
  TRAINABLE_MODELS,
  type ClassifiedSource,
  type FoundryJob,
  type HardwareProfile,
  type TrainingMethod,
  type TrainingWorkerCapability,
} from './modelHub';
import {
  cancelVerifiedTrainingModelDownload,
  downloadVerifiedTrainingModel,
  listVerifiedTrainingModels,
  repairVerifiedTrainingModel,
  removeVerifiedTrainingModel,
  verifiedTrainingModelToTrainableModel,
  type LocalTrainingWorkerStatus,
  type VerifiedTrainingModel,
} from './trainingRuntime';

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  onActivateArtifact?(job: FoundryJob): void;
  trainingWorker?: LocalTrainingWorkerStatus | null;
  verifiedTrainingModels?: readonly VerifiedTrainingModel[];
}

const steps = ['Purpose', 'Base model', 'Identity', 'Sources', 'Review', 'Train'] as const;

export async function detectHardware(): Promise<HardwareProfile> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<HardwareProfile>('model_foundry_detect_hardware');
  } catch {
    // Browser preview falls through to conservative web-platform signals.
  }
  let freeStorageGb = 0;
  try {
    const estimate = await navigator.storage?.estimate();
    freeStorageGb = Math.max(
      0,
      Math.round(((estimate?.quota ?? 0) - (estimate?.usage ?? 0)) / 1024 ** 3),
    );
  } catch {
    // The compatibility UI remains conservative when browser storage cannot be measured.
  }
  const memory = Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 0);
  return {
    cpu: `${navigator.hardwareConcurrency || 'Unknown'} logical CPU threads`,
    gpu: null,
    ramGb: memory,
    vramGb: 0,
    freeStorageGb,
    os:
      (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
        ?.platform ??
      navigator.platform ??
      'Unknown',
    accelerators: [],
  };
}

export function BuildYourOwnAIHub({
  open,
  onOpenChange,
  onActivateArtifact,
  trainingWorker = null,
  verifiedTrainingModels,
}: Props) {
  const [step, setStep] = React.useState(0);
  const [method, setMethod] = React.useState<TrainingMethod>('knowledge');
  const [purpose, setPurpose] = React.useState('');
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [instructions, setInstructions] = React.useState('');
  const [modelId, setModelId] = React.useState(TRAINABLE_MODELS[0].id);
  const [hardware, setHardware] = React.useState<HardwareProfile>({
    cpu: 'Detecting…',
    gpu: null,
    ramGb: 0,
    vramGb: 0,
    freeStorageGb: 0,
    os: 'Detecting…',
    accelerators: [],
  });
  const [sources, setSources] = React.useState<ClassifiedSource[]>([]);
  const [jobs, setJobs] = React.useState<FoundryJob[]>(() => loadJobs(window.localStorage));
  const [error, setError] = React.useState('');
  const [installedModels, setInstalledModels] = React.useState<string[]>([]);
  const [ollamaReady, setOllamaReady] = React.useState(false);
  const [downloadProgress, setDownloadProgress] = React.useState<number | null>(null);
  const downloadAbortRef = React.useRef<AbortController | null>(null);
  const [trainingCatalog, setTrainingCatalog] = React.useState<VerifiedTrainingModel[]>(
    () => verifiedTrainingModels?.slice() ?? [],
  );
  const [confirmRemoveModelId, setConfirmRemoveModelId] = React.useState<string | null>(null);
  const [busyJobId, setBusyJobId] = React.useState<string | null>(null);
  const [confirmDeleteJobId, setConfirmDeleteJobId] = React.useState<string | null>(null);
  const [renameJobId, setRenameJobId] = React.useState<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState('');
  const [revealJobId, setRevealJobId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    void detectHardware().then(setHardware);
    if (verifiedTrainingModels) {
      setTrainingCatalog(verifiedTrainingModels.slice());
    } else {
      void listVerifiedTrainingModels()
        .then(setTrainingCatalog)
        .catch((caught: unknown) => {
          setError(
            caught instanceof Error
              ? caught.message
              : 'Could not inspect the verified training model catalog.',
          );
        });
    }
    let cancelled = false;
    void import('@/lib/ai/ollamaBootstrap')
      .then(({ bootstrapOllamaConnection }) => bootstrapOllamaConnection({ force: true }))
      .then(async (result) => {
        if (cancelled) return;
        setOllamaReady(result.ready);
        if (!result.ready) return;
        const { listOllamaModels } = await import('@/lib/ai/providers/ollama');
        const models = await listOllamaModels();
        if (!cancelled) setInstalledModels(models);
      })
      .catch(() => {
        if (!cancelled) setOllamaReady(false);
      });
    return () => {
      cancelled = true;
      downloadAbortRef.current?.abort();
      downloadAbortRef.current = null;
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    void import('@/lib/ai/models').then(({ syncFoundryModelOptions }) =>
      syncFoundryModelOptions(foundryModelOptions(jobs)),
    );
    let cancelled = false;
    const refresh = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const nativeJobs = await invoke<FoundryJob[]>('model_foundry_list_jobs');
        if (!cancelled) {
          const completedJobId = newlyCompletedJobId(jobs, nativeJobs);
          if (completedJobId) {
            setRevealJobId(completedJobId);
            setStep(5);
          }
          setJobs(nativeJobs);
          saveJobs(window.localStorage, nativeJobs);
          const { syncFoundryModelOptions } = await import('@/lib/ai/models');
          syncFoundryModelOptions(foundryModelOptions(nativeJobs));
        }
      } catch {
        // Browser preview and unavailable native runtimes retain the last durable UI snapshot.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open]);

  const trainingWorkerCapability = React.useMemo<TrainingWorkerCapability | null>(
    () =>
      trainingWorker
        ? {
            installed: trainingWorker.installed,
            attested: trainingWorker.attested,
            version: String(trainingWorker.protocol),
            methods: trainingWorker.methods,
            modalities: trainingWorker.modalities,
            precisions: trainingWorker.precisions,
          }
        : null,
    [trainingWorker],
  );
  const availableModels = React.useMemo(
    () =>
      method === 'knowledge'
        ? TRAINABLE_MODELS
        : trainingCatalog.map(verifiedTrainingModelToTrainableModel),
    [method, trainingCatalog],
  );
  React.useEffect(() => {
    if (availableModels.length > 0 && !availableModels.some((model) => model.id === modelId)) {
      setModelId(availableModels[0].id);
    }
  }, [availableModels, modelId]);
  const selectedModel =
    availableModels.find((model) => model.id === modelId) ??
    availableModels[0] ??
    TRAINABLE_MODELS[0];
  const selectedVerifiedModel =
    method === 'knowledge'
      ? null
      : (trainingCatalog.find((model) => model.id === selectedModel.id) ?? null);
  const assessed = React.useMemo(() => {
    const base = compatibleModels(hardware, availableModels);
    if (method === 'knowledge') return base;
    const planned = base.map((item) => {
      const plan = planLocalTrainingMethod({
        method,
        parametersB: item.model.parametersB,
        hardware,
        worker: trainingWorkerCapability,
      });
      return {
        ...item,
        compatible: item.compatible && plan.available,
        recommended: false,
        warning: plan.available ? item.warning : plan.reason,
      };
    });
    const best = [...planned]
      .filter((item) => item.compatible)
      .sort((left, right) => right.model.parametersB - left.model.parametersB)[0];
    if (best) best.recommended = true;
    return planned;
  }, [availableModels, hardware, method, trainingWorkerCapability]);
  const validationError = mayStartTraining({
    name,
    model: selectedModel,
    method,
    hardware,
    sources,
    worker: trainingWorkerCapability,
  });
  const selectedModelInstalled =
    method === 'knowledge'
      ? isModelInstalled(selectedModel.id, installedModels)
      : selectedVerifiedModel?.status === 'ready';
  const startError =
    (method !== 'knowledge' && !selectedVerifiedModel
      ? 'The verified trainable model catalog is unavailable.'
      : validationError) ??
    (!selectedModelInstalled
      ? `Download and verify ${selectedModel.label} before local processing.`
      : null);

  const addSources = (files: FileList | null) => {
    if (!files) return;
    setSources((current) => [
      ...current,
      ...Array.from(files).map((file) => classifySource(file.name, method, false)),
    ]);
  };

  const pickLocalSources = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        multiple: true,
        directory: false,
        title: 'Choose local Model Foundry sources',
      });
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
      setSources((current) => [
        ...current,
        ...paths.map((path) =>
          classifySource(path.split(/[\\/]/).pop() ?? path, method, false, path),
        ),
      ]);
    } catch {
      setError('The native file picker is unavailable. No private file was accessed.');
    }
  };

  const start = async () => {
    if (startError) {
      setError(startError);
      return;
    }
    setError('');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const created = await invoke<FoundryJob>('model_foundry_start_training', {
        request: {
          name: name.trim(),
          description: description.trim(),
          purpose: purpose.trim(),
          instructions: instructions.trim() || null,
          baseModelId: selectedModel.id,
          method,
          sourcePaths: sources
            .filter((source) => source.use !== 'unsupported')
            .map((source) => source.path)
            .filter((path): path is string => Boolean(path)),
          localOnly: true,
        },
      });
      const next = [created, ...jobs.filter((job) => job.id !== created.id)];
      setJobs(next);
      saveJobs(window.localStorage, next);
      setStep(5);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The verified local training backend is unavailable. No training was started.',
      );
    }
  };

  const downloadSelectedModel = async () => {
    setError('');
    setDownloadProgress(0);
    if (method !== 'knowledge') {
      if (!selectedVerifiedModel) {
        setDownloadProgress(null);
        setError('The selected model has no verified training manifest.');
        return;
      }
      let unlisten: (() => void) | null = null;
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<{
          modelId: string;
          percent: number;
          phase: string;
        }>('model-foundry:training-model-download', ({ payload }) => {
          if (payload.modelId === selectedVerifiedModel.id) {
            setDownloadProgress(Math.max(0, Math.min(100, Math.round(payload.percent))));
          }
        });
        const updated =
          selectedVerifiedModel.status === 'repair-required'
            ? await repairVerifiedTrainingModel(selectedVerifiedModel.id)
            : await downloadVerifiedTrainingModel(selectedVerifiedModel.id);
        setTrainingCatalog((current) =>
          current.map((model) => (model.id === updated.id ? updated : model)),
        );
        setDownloadProgress(null);
      } catch (caught) {
        setDownloadProgress(null);
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        unlisten?.();
      }
      return;
    }
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    try {
      const { bootstrapOllamaConnection } = await import('@/lib/ai/ollamaBootstrap');
      const bootstrap = await bootstrapOllamaConnection({
        force: true,
        signal: controller.signal,
      });
      if (!bootstrap.ready) {
        throw new Error(
          'Ollama needs installation consent. Open Settings → Local Models to review and install the official runtime.',
        );
      }
      setOllamaReady(true);
      const { listOllamaModels, pullOllamaModel } = await import('@/lib/ai/providers/ollama');
      await pullOllamaModel(
        selectedModel.id,
        (progress) =>
          setDownloadProgress(
            typeof progress.percent === 'number' ? Math.round(progress.percent) : null,
          ),
        controller.signal,
      );
      const models = await listOllamaModels();
      setInstalledModels(models);
      setDownloadProgress(null);
    } catch (caught) {
      setDownloadProgress(null);
      if (caught instanceof DOMException && caught.name === 'AbortError') {
        setError('Model download cancelled. Partial data was not activated.');
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      downloadAbortRef.current = null;
    }
  };

  const cancelSelectedModelDownload = async () => {
    if (downloadAbortRef.current) {
      downloadAbortRef.current.abort();
      return;
    }
    try {
      await cancelVerifiedTrainingModelDownload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const repairSelectedTrainingModel = async () => {
    if (!selectedVerifiedModel) return;
    setError('');
    setDownloadProgress(0);
    try {
      const updated = await repairVerifiedTrainingModel(selectedVerifiedModel.id);
      setTrainingCatalog((current) =>
        current.map((model) => (model.id === updated.id ? updated : model)),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDownloadProgress(null);
    }
  };

  const removeSelectedTrainingModel = async () => {
    if (!selectedVerifiedModel) return;
    if (confirmRemoveModelId !== selectedVerifiedModel.id) {
      setConfirmRemoveModelId(selectedVerifiedModel.id);
      return;
    }
    setError('');
    try {
      const updated = await removeVerifiedTrainingModel(selectedVerifiedModel.id);
      setTrainingCatalog((current) =>
        current.map((model) => (model.id === updated.id ? updated : model)),
      );
      setConfirmRemoveModelId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const runJobAction = async (
    command:
      | 'model_foundry_cancel_job'
      | 'model_foundry_retry_job'
      | 'model_foundry_resume_job'
      | 'model_foundry_retrain_artifact'
      | 'model_foundry_delete_job'
      | 'model_foundry_rename_artifact'
      | 'model_foundry_duplicate_artifact',
    job: FoundryJob,
    extra: Record<string, unknown> = {},
  ) => {
    setBusyJobId(job.id);
    setError('');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (command === 'model_foundry_delete_job') {
        await invoke(command, { jobId: job.id });
        const next = jobs.filter((candidate) => candidate.id !== job.id);
        setJobs(next);
        saveJobs(window.localStorage, next);
        const { syncFoundryModelOptions } = await import('@/lib/ai/models');
        syncFoundryModelOptions(foundryModelOptions(next));
        setConfirmDeleteJobId(null);
      } else {
        const changed = await invoke<FoundryJob>(command, {
          jobId: job.id,
          ...extra,
        });
        const next = [changed, ...jobs.filter((candidate) => candidate.id !== changed.id)];
        setJobs(next);
        saveJobs(window.localStorage, next);
        const { syncFoundryModelOptions } = await import('@/lib/ai/models');
        syncFoundryModelOptions(foundryModelOptions(next));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyJobId(null);
    }
  };

  const exportArtifact = async (job: FoundryJob) => {
    setBusyJobId(job.id);
    setError('');
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const destination = await save({
        title: `Export ${job.name}`,
        defaultPath: `${job.name.replace(/[^a-z0-9_-]+/gi, '-') || 'model-foundry'}.json`,
        filters: [{ name: 'Model Foundry artifact', extensions: ['json'] }],
      });
      if (!destination) return;
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('model_foundry_export_artifact', {
        jobId: job.id,
        destination,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyJobId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto p-0">
        <div className="border-b border-border bg-background/70 px-6 py-5">
          <div className="flex items-center gap-3">
            <span className="rounded-xl border border-accent-cyan/30 bg-accent-cyan/10 p-2 text-accent-cyan">
              <FlaskConical className="h-5 w-5" />
            </span>
            <div>
              <DialogTitle>Build Your Own AI</DialogTitle>
              <DialogDescription>
                Create real retrieval knowledge or supported adapter weights—not a prompt disguised
                as a model.
              </DialogDescription>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button type="button" variant="ghost" onClick={() => setStep(5)}>
              View model library
            </Button>
          </div>
          <ol className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="Model build steps">
            {steps.map((label, index) => (
              <li
                key={label}
                className={cn(
                  'rounded-md border px-2 py-2 text-center text-metadata',
                  index === step
                    ? 'border-accent-cyan/60 bg-accent-cyan/10 text-foreground'
                    : index < step
                      ? 'border-emerald-500/30 text-emerald-300'
                      : 'border-border text-muted-foreground',
                )}
              >
                {index + 1}. {label}
              </li>
            ))}
          </ol>
        </div>

        <div className="space-y-5 p-6">
          {step === 0 && (
            <>
              <div>
                <h3 className="text-section-title">What are you building?</h3>
                <p className="text-secondary text-muted-foreground">
                  Default behavior is optional and remains separate from training.
                </p>
              </div>
              <Label>Purpose</Label>
              <Textarea
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                placeholder="A coding specialist for this repository…"
              />
              <div className="grid gap-3 md:grid-cols-2">
                {(
                  [
                    [
                      'knowledge',
                      'Knowledge training',
                      'Private sources are cleaned and indexed for local RAG. No weights are changed.',
                    ],
                    [
                      'lora',
                      'LoRA fine-tuning',
                      'Train a reusable adapter with a supported local backend.',
                    ],
                    [
                      'qlora',
                      'QLoRA fine-tuning',
                      'Train a quantized adapter with lower VRAM requirements.',
                    ],
                    [
                      'full',
                      'Advanced full fine-tuning',
                      'Shown honestly and enabled only when the backend and hardware support it.',
                    ],
                  ] as const
                ).map(([id, title, copy]) => {
                  const availability = modelFoundryMethodAvailability(id, trainingWorkerCapability);
                  return (
                    <button
                      key={id}
                      type="button"
                      disabled={!availability.available}
                      onClick={() => setMethod(id)}
                      className={cn(
                        'rounded-lg border p-4 text-left disabled:cursor-not-allowed disabled:opacity-60',
                        method === id ? 'border-accent-cyan bg-accent-cyan/10' : 'border-border',
                      )}
                    >
                      <strong>{title}</strong>
                      <span className="mt-1 block text-secondary text-muted-foreground">
                        {availability.reason ?? copy}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2 lg:grid-cols-3">
                <span>
                  <Cpu className="inline h-4 w-4" /> {hardware.cpu}
                </span>
                <span>
                  <HardDrive className="inline h-4 w-4" /> {hardware.ramGb || '?'} GB RAM
                </span>
                <span>
                  <Database className="inline h-4 w-4" /> {hardware.freeStorageGb || '?'} GB
                  measured free
                </span>
                <span>Operating system: {hardware.os || 'Not reported'}</span>
                <span>
                  GPU: {hardware.gpu ?? 'Not reported'} · {hardware.vramGb || '?'} GB VRAM
                </span>
                <span>
                  Acceleration:{' '}
                  {hardware.accelerators.length > 0
                    ? hardware.accelerators.join(', ')
                    : 'Not reported'}
                </span>
              </div>
              <div className="grid gap-3">
                {assessed.map(({ model, compatible, recommended, warning }) => {
                  const verified = trainingCatalog.find((entry) => entry.id === model.id);
                  return (
                    <button
                      key={model.id}
                      type="button"
                      disabled={!compatible}
                      onClick={() => setModelId(model.id)}
                      className={cn(
                        'rounded-lg border p-4 text-left disabled:opacity-55',
                        modelId === model.id
                          ? 'border-accent-cyan bg-accent-cyan/10'
                          : 'border-border',
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <strong>{model.label}</strong>
                        {recommended && (
                          <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-metadata text-emerald-300">
                            Best for your PC
                          </span>
                        )}
                        <span className="rounded bg-muted px-2 py-0.5 text-metadata">
                          {model.speed}
                        </span>
                        <span className="rounded bg-muted px-2 py-0.5 text-metadata">
                          {model.quality} quality
                        </span>
                      </div>
                      <p className="mt-2 text-secondary text-muted-foreground">
                        {model.parametersB}B parameters · ~{model.downloadGb} GB download ·{' '}
                        {model.ramGb} GB RAM / {model.vramGb} GB VRAM · {model.quantization} · fully
                        local
                      </p>
                      <p className="mt-1 text-secondary text-muted-foreground">
                        Supported build path:{' '}
                        {model.methods.includes('knowledge')
                          ? 'Knowledge/RAG'
                          : model.methods.map((value) => value.toUpperCase()).join(' · ')}
                        {' · '}
                        {recommended
                          ? 'Recommended for your hardware'
                          : compatible
                            ? 'Compatible with measured hardware'
                            : 'Not compatible with measured hardware'}
                      </p>
                      {verified ? (
                        <>
                          <p className="mt-2 text-secondary">
                            {verified.status === 'ready'
                              ? 'Installed and manifest verified'
                              : verified.status === 'repair-required'
                                ? 'Installed files require repair'
                                : 'Not installed'}
                          </p>
                          <p className="mt-1 break-all font-mono text-metadata text-muted-foreground">
                            {verified.sourceId} · revision {verified.revision.slice(0, 12)} ·{' '}
                            {verified.contextTokens.toLocaleString()} context · Apache-2.0 ·{' '}
                            {verified.licenseUrl}
                          </p>
                        </>
                      ) : (
                        <p className="mt-2 text-secondary">
                          {isModelInstalled(model.id, installedModels)
                            ? 'Installed and verified in Ollama'
                            : 'Not installed'}
                        </p>
                      )}
                      {warning && <p className="mt-2 text-secondary text-amber-300">{warning}</p>}
                    </button>
                  );
                })}
              </div>
              {!selectedModelInstalled && (
                <div className="rounded-lg border border-accent-cyan/30 bg-accent-cyan/5 p-4">
                  <p className="text-secondary text-muted-foreground">
                    {method === 'knowledge'
                      ? ollamaReady
                        ? 'Download from the verified Ollama catalog before building this local artifact.'
                        : 'Ollama is unavailable. Installation requires the consent flow in Settings → Local Models.'
                      : selectedVerifiedModel?.status === 'repair-required'
                        ? 'The installed checkpoint failed its manifest status check. Repair downloads and verifies only the pinned official files.'
                        : 'Download the revision-pinned checkpoint from its verified official source. Every file is size- and SHA-256-verified before activation.'}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="accent"
                      disabled={
                        (method === 'knowledge' && !ollamaReady) ||
                        !selectedModel ||
                        downloadProgress !== null
                      }
                      onClick={() => void downloadSelectedModel()}
                    >
                      {downloadProgress === null
                        ? selectedVerifiedModel?.status === 'repair-required'
                          ? `Repair ${selectedModel.label}`
                          : `Download ${selectedModel.label}`
                        : `Downloading ${downloadProgress}%`}
                    </Button>
                    {downloadProgress !== null && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => void cancelSelectedModelDownload()}
                      >
                        Cancel download
                      </Button>
                    )}
                    {method === 'knowledge' && !ollamaReady && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          onOpenChange(false);
                          window.dispatchEvent(
                            new CustomEvent('jarvis:settings:tab', {
                              detail: { tab: 'local-models' },
                            }),
                          );
                        }}
                      >
                        Open Local Models setup
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {method !== 'knowledge' && selectedVerifiedModel?.status === 'ready' && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
                  <p className="text-secondary text-muted-foreground">
                    Ready · {formatFoundryStorageBytes(selectedVerifiedModel.installedBytes)} ·
                    pinned revision {selectedVerifiedModel.revision.slice(0, 12)}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={downloadProgress !== null}
                      onClick={() => void repairSelectedTrainingModel()}
                    >
                      Verify and repair
                    </Button>
                    {confirmRemoveModelId === selectedVerifiedModel.id ? (
                      <>
                        <Button
                          type="button"
                          variant="destructive"
                          onClick={() => void removeSelectedTrainingModel()}
                        >
                          Confirm remove local checkpoint
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => setConfirmRemoveModelId(null)}
                        >
                          Keep model
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => void removeSelectedTrainingModel()}
                      >
                        Remove…
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div>
                <Label htmlFor="foundry-name">Model name</Label>
                <Input
                  id="foundry-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="foundry-description">Description</Label>
                <Textarea
                  id="foundry-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="foundry-instructions">Default behavior (optional)</Label>
                <Textarea
                  id="foundry-instructions"
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  placeholder="This does not train weights."
                />
              </div>
            </div>
          )}

          {step === 3 && (
            <>
              <button
                type="button"
                onClick={() => void pickLocalSources()}
                className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-accent-cyan/50 p-8"
              >
                <Upload className="h-5 w-5" /> Add documents, code, datasets, images, audio, or
                video
              </button>
              <label className="sr-only">
                Browser fallback source picker
                <input type="file" multiple onChange={(event) => addSources(event.target.files)} />
              </label>
              <p className="text-secondary text-muted-foreground">
                Files stay local. Nothing is uploaded without a separate explicit permission flow.
              </p>
              {sources.map((source, index) => (
                <div
                  key={`${source.name}-${index}`}
                  className="rounded-md border border-border p-3"
                >
                  <strong>{source.name}</strong>
                  <span className="ml-2 text-metadata uppercase text-accent-cyan">
                    {source.use.replace('_', ' ')}
                  </span>
                  <p className="text-secondary text-muted-foreground">{source.explanation}</p>
                </div>
              ))}
            </>
          )}

          {step === 4 && (
            <div className="space-y-3 rounded-lg border border-border p-5">
              <h3 className="text-section-title">Review before local processing</h3>
              <p>
                <strong>{name || 'Unnamed model'}</strong> · {selectedModel.label} ·{' '}
                {method.toUpperCase()}
              </p>
              <p className="text-secondary text-muted-foreground">{purpose}</p>
              <p>
                {sources.filter((source) => source.use !== 'unsupported').length} usable sources;{' '}
                {sources.filter((source) => source.use === 'unsupported').length} ignored with
                explanations.
              </p>
              {startError && <p className="text-amber-300">{startError}</p>}
            </div>
          )}

          {step === 5 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-accent-cyan" />
                <h3 className="text-section-title">Persistent model jobs</h3>
              </div>
              {jobs.length === 0 ? (
                <p className="text-muted-foreground">No verified job has started.</p>
              ) : (
                jobs.map((job) => (
                  <div
                    key={job.id}
                    className={cn(
                      'rounded-lg border p-4',
                      revealJobId === job.id
                        ? 'animate-scale-in border-accent-cyan bg-accent-cyan/5'
                        : 'border-border',
                    )}
                  >
                    {revealJobId === job.id && (
                      <p className="mb-2 text-metadata font-semibold uppercase tracking-wider text-accent-cyan">
                        Your verified local model is ready
                      </p>
                    )}
                    <div className="flex justify-between">
                      <strong>{job.name}</strong>
                      <span>{job.status}</span>
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded bg-muted">
                      <div
                        className="h-full bg-accent-cyan"
                        style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }}
                      />
                    </div>
                    <p className="mt-2 text-secondary text-muted-foreground">
                      v{job.version ?? 1} · {job.progress}% · {job.sourceCount ?? 0} sources ·{' '}
                      {job.artifactVerified && job.artifactPath
                        ? `Verified artifact: ${job.artifactPath}`
                        : 'Artifact not yet verified'}
                    </p>
                    <p className="mt-1 text-secondary text-muted-foreground">
                      Local artifact storage: {formatFoundryStorageBytes(job.storageBytes)}
                    </p>
                    {job.artifactSha256 && (
                      <p className="mt-1 truncate font-mono text-metadata text-muted-foreground">
                        SHA-256 {job.artifactSha256}
                      </p>
                    )}
                    {job.status === 'completed' &&
                      job.artifactVerified &&
                      job.artifactPath &&
                      onActivateArtifact && (
                        <Button
                          type="button"
                          variant="accent"
                          className="mt-3"
                          onClick={() => onActivateArtifact(job)}
                          aria-label={`Use ${job.name} with this agent`}
                        >
                          Use with this agent
                        </Button>
                      )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {[
                        'queued',
                        'validating',
                        'preparing',
                        'training',
                        'evaluating',
                        'packaging',
                      ].includes(job.status) && (
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={busyJobId === job.id}
                          onClick={() => void runJobAction('model_foundry_cancel_job', job)}
                        >
                          Cancel
                        </Button>
                      )}
                      {(job.status === 'failed' || job.status === 'cancelled') && (
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={busyJobId === job.id}
                          onClick={() => void runJobAction('model_foundry_retry_job', job)}
                        >
                          Retry
                        </Button>
                      )}
                      {job.status === 'failed' && job.resumeAvailable && (
                        <Button
                          type="button"
                          variant="accent"
                          disabled={busyJobId === job.id}
                          onClick={() => void runJobAction('model_foundry_resume_job', job)}
                        >
                          Resume from checkpoint
                        </Button>
                      )}
                      {['completed', 'failed', 'cancelled'].includes(job.status) &&
                        (confirmDeleteJobId === job.id ? (
                          <>
                            <Button
                              type="button"
                              variant="destructive"
                              disabled={busyJobId === job.id}
                              onClick={() => void runJobAction('model_foundry_delete_job', job)}
                            >
                              Delete artifact and local data
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => setConfirmDeleteJobId(null)}
                            >
                              Keep
                            </Button>
                          </>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => setConfirmDeleteJobId(job.id)}
                          >
                            Delete…
                          </Button>
                        ))}
                      {job.status === 'completed' && job.artifactVerified && (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={busyJobId === job.id}
                            onClick={() => {
                              setRenameJobId(job.id);
                              setRenameDraft(job.name);
                            }}
                          >
                            Rename
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={busyJobId === job.id}
                            onClick={() =>
                              void runJobAction('model_foundry_duplicate_artifact', job, {
                                name: `${job.name} Copy`,
                              })
                            }
                          >
                            Duplicate
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={busyJobId === job.id}
                            onClick={() => void runJobAction('model_foundry_retrain_artifact', job)}
                          >
                            Retrain as v{(job.version ?? 1) + 1}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={busyJobId === job.id}
                            onClick={() => void exportArtifact(job)}
                          >
                            Export
                          </Button>
                        </>
                      )}
                    </div>
                    {renameJobId === job.id && (
                      <div className="mt-3 flex gap-2">
                        <Input
                          aria-label={`New name for ${job.name}`}
                          value={renameDraft}
                          maxLength={80}
                          onChange={(event) => setRenameDraft(event.target.value)}
                        />
                        <Button
                          type="button"
                          variant="accent"
                          disabled={!renameDraft.trim() || busyJobId === job.id}
                          onClick={() => {
                            void runJobAction('model_foundry_rename_artifact', job, {
                              name: renameDraft.trim(),
                            });
                            setRenameJobId(null);
                          }}
                        >
                          Save name
                        </Button>
                        <Button type="button" variant="ghost" onClick={() => setRenameJobId(null)}>
                          Cancel rename
                        </Button>
                      </div>
                    )}
                    {job.error && (
                      <p className="mt-2 text-secondary text-destructive">{job.error}</p>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-secondary text-destructive"
            >
              {error}
            </div>
          )}

          <div className="flex justify-between border-t border-border pt-4">
            <Button
              variant="ghost"
              disabled={step === 0}
              onClick={() => setStep((current) => Math.max(0, current - 1))}
            >
              Back
            </Button>
            {step < 4 ? (
              <Button
                variant="accent"
                onClick={() => setStep((current) => Math.min(4, current + 1))}
              >
                Continue
              </Button>
            ) : step === 4 ? (
              <Button variant="accent" disabled={Boolean(startError)} onClick={() => void start()}>
                Begin local processing
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Continue using VibeSpace
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
