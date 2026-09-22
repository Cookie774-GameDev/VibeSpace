import * as React from 'react';
import {
  AlertTriangle,
  Check,
  Cpu,
  Database,
  FileText,
  FlaskConical,
  HardDrive,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn, isTauri } from '@/lib/utils';
import { readTextFile } from '@/lib/fs';
import {
  classifySource,
  compatibleModels,
  applyTrainingComputePreset,
  defaultFoundryTrainingConfiguration,
  estimateFoundryTrainingDuration,
  emptyTrainingMeasurement,
  formatFoundryStorageBytes,
  foundryModelOptions,
  isModelInstalled,
  loadJobs,
  mayStartTraining,
  measureTrainingJsonl,
  measureTrainingText,
  modelFoundryMethodAvailability,
  newlyCompletedJobId,
  planLocalTrainingMethod,
  saveJobs,
  TRAINING_COMPUTE_PRESETS,
  TRAINABLE_MODELS,
  validateFoundryTrainingConfiguration,
  type ClassifiedSource,
  type FoundryTrainingConfiguration,
  type FoundryJob,
  type HardwareProfile,
  type TrainingMethod,
  type TrainingComputePresetId,
  type TrainingWorkerCapability,
} from './modelHub';
import {
  calibrateLocalTraining,
  cancelVerifiedTrainingModelDownload,
  downloadVerifiedTrainingModel,
  getLocalTrainingWorkerStatus,
  installLocalTrainingWorker,
  listVerifiedTrainingModels,
  repairVerifiedTrainingModel,
  removeVerifiedTrainingModel,
  verifiedTrainingModelToTrainableModel,
  type LocalTrainingWorkerStatus,
  type TrainingCalibrationEvidence,
  type VerifiedTrainingModel,
} from './trainingRuntime';
import {
  createNativeFoundryFileDropHandler,
  distinctFoundryPaths,
  type NativeFoundryFileDropEvent,
} from './nativeFoundryFileDrop';

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  onActivateArtifact?(job: FoundryJob): void;
  trainingWorker?: LocalTrainingWorkerStatus | null;
  initialMethod?: TrainingMethod;
  verifiedTrainingModels?: readonly VerifiedTrainingModel[];
}

const steps = ['Purpose', 'Base model', 'Identity', 'Sources', 'Review', 'Train'] as const;

function numericInputValue(value: number): number | '' {
  return Number.isFinite(value) ? value : '';
}

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
  trainingWorker,
  verifiedTrainingModels,
  initialMethod,
}: Props) {
  const [step, setStep] = React.useState(0);
  React.useEffect(() => {
    if (!open || !initialMethod) return;
    setMethod(initialMethod);
    if (initialMethod !== 'knowledge')
      setTrainingConfig(defaultFoundryTrainingConfiguration(initialMethod));
    setStep(0);
  }, [open, initialMethod]);
  const [method, setMethod] = React.useState<TrainingMethod>('knowledge');
  const [trainingConfig, setTrainingConfig] = React.useState<FoundryTrainingConfiguration>(() =>
    defaultFoundryTrainingConfiguration('lora'),
  );
  const [computePresetId, setComputePresetId] = React.useState<TrainingComputePresetId | null>(
    'low-memory',
  );
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
  const [transcriptionReady, setTranscriptionReady] = React.useState(false);
  const [downloadProgress, setDownloadProgress] = React.useState<number | null>(null);
  const downloadAbortRef = React.useRef<AbortController | null>(null);
  const [trainingCatalog, setTrainingCatalog] = React.useState<VerifiedTrainingModel[]>(
    () => verifiedTrainingModels?.slice() ?? [],
  );
  const [resolvedTrainingWorker, setResolvedTrainingWorker] =
    React.useState<LocalTrainingWorkerStatus | null>(null);
  const [trainingSetupBusy, setTrainingSetupBusy] = React.useState(false);
  const [trainingSetupError, setTrainingSetupError] = React.useState<string | null>(null);
  const [trainingCalibration, setTrainingCalibration] = React.useState<{
    key: string;
    evidence: TrainingCalibrationEvidence;
  } | null>(null);
  const [trainingCalibrationBusy, setTrainingCalibrationBusy] = React.useState(false);
  const [requestedStorageRoot, setRequestedStorageRoot] = React.useState<string | null>(null);
  const [confirmRemoveModelId, setConfirmRemoveModelId] = React.useState<string | null>(null);
  const [busyJobId, setBusyJobId] = React.useState<string | null>(null);
  const [confirmDeleteJobId, setConfirmDeleteJobId] = React.useState<string | null>(null);
  const [renameJobId, setRenameJobId] = React.useState<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState('');
  const [revealJobId, setRevealJobId] = React.useState<string | null>(null);
  const [sourceDropActive, setSourceDropActive] = React.useState(false);
  const sourceDropZoneRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void detectHardware().then((profile) => {
      if (!cancelled) setHardware(profile);
    });
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<{ ready: boolean }>('faster_whisper_status', { model: 'base' }))
      .then((status) => {
        if (!cancelled) setTranscriptionReady(status.ready === true);
      })
      .catch(() => {
        if (!cancelled) setTranscriptionReady(false);
      });
    if (verifiedTrainingModels) {
      setTrainingCatalog(verifiedTrainingModels.slice());
    } else {
      void listVerifiedTrainingModels()
        .then((models) => {
          if (!cancelled) setTrainingCatalog(models);
        })
        .catch((caught: unknown) => {
          if (!cancelled) {
            setError(
              caught instanceof Error
                ? caught.message
                : 'Could not inspect the verified training model catalog.',
            );
          }
        });
    }
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
    let cancelled = false;
    let refreshing = false;
    void import('@/lib/ai/models').then(({ syncFoundryModelOptions }) => {
      if (!cancelled) syncFoundryModelOptions(foundryModelOptions(jobs));
    });
    const refresh = async () => {
      if (refreshing || cancelled) return;
      refreshing = true;
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
          if (!cancelled) syncFoundryModelOptions(foundryModelOptions(nativeJobs));
        }
      } catch {
        // Browser preview and unavailable native runtimes retain the last durable UI snapshot.
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    if (trainingWorker !== undefined) {
      setResolvedTrainingWorker(trainingWorker);
      return;
    }
    let cancelled = false;
    void getLocalTrainingWorkerStatus()
      .then((status) => {
        if (!cancelled) setResolvedTrainingWorker(status);
      })
      .catch(() => {
        if (!cancelled) setResolvedTrainingWorker(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, trainingWorker]);

  const effectiveTrainingWorker = resolvedTrainingWorker;

  const trainingWorkerCapability = React.useMemo<TrainingWorkerCapability | null>(
    () =>
      effectiveTrainingWorker
        ? {
            installed: effectiveTrainingWorker.installed,
            attested: effectiveTrainingWorker.attested,
            version: String(effectiveTrainingWorker.protocol),
            methods: effectiveTrainingWorker.methods,
            modalities: effectiveTrainingWorker.modalities,
            precisions: effectiveTrainingWorker.precisions,
          }
        : null,
    [effectiveTrainingWorker],
  );
  const availableModels = React.useMemo(
    () =>
      method === 'knowledge'
        ? TRAINABLE_MODELS
        : trainingCatalog
            .map(verifiedTrainingModelToTrainableModel)
            .sort((left, right) => left.parametersB - right.parametersB),
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
  const calibrationKey = React.useMemo(
    () =>
      JSON.stringify({
        modelId: selectedModel.id,
        method,
        configuration: method === 'knowledge' ? null : trainingConfig,
      }),
    [method, selectedModel.id, trainingConfig],
  );
  const matchingCalibration =
    trainingCalibration?.key === calibrationKey ? trainingCalibration.evidence : null;
  const availableTrainingModalities = React.useMemo(
    () =>
      method === 'knowledge'
        ? (['text'] as const)
        : (selectedModel.modalities ?? ['text']).filter((modality) =>
            trainingWorkerCapability?.modalities.includes(modality),
          ),
    [method, selectedModel.modalities, trainingWorkerCapability],
  );
  const assessed = React.useMemo(() => {
    const base = compatibleModels(hardware, availableModels);
    if (method === 'knowledge') return base;
    const planned = base.map((item) => {
      const plan = planLocalTrainingMethod({
        method,
        parametersB: item.model.parametersB,
        hardware,
        worker: trainingWorkerCapability,
        computeDevice: trainingConfig.computeDevice,
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
      .sort((left, right) => left.model.parametersB - right.model.parametersB)[0];
    if (best) best.recommended = true;
    return planned;
  }, [availableModels, hardware, method, trainingConfig.computeDevice, trainingWorkerCapability]);
  const validationError = mayStartTraining({
    name,
    model: selectedModel,
    method,
    hardware,
    sources,
    worker: trainingWorkerCapability,
    configuration: method === 'knowledge' ? undefined : trainingConfig,
  });
  const selectedModelInstalled =
    method === 'knowledge'
      ? isModelInstalled(selectedModel.id, installedModels)
      : selectedVerifiedModel?.status === 'ready';
  const calibrationError =
    method === 'knowledge' || !selectedModelInstalled
      ? null
      : matchingCalibration?.qualified
        ? null
        : (matchingCalibration?.reason ??
          `Run ${trainingConfig.computeDevice.toUpperCase()} calibration before starting weight training.`);
  const startError =
    (method !== 'knowledge' && !selectedVerifiedModel
      ? 'The verified trainable model catalog is unavailable.'
      : validationError) ??
    (!selectedModelInstalled
      ? `Download and verify ${selectedModel.label} before local processing.`
      : null) ??
    (method === 'knowledge' ? null : validateFoundryTrainingConfiguration(trainingConfig)) ??
    calibrationError;
  const datasetMeasurement = React.useMemo(() => {
    const total = emptyTrainingMeasurement();
    for (const source of sources) {
      if (source.use === 'unsupported') continue;
      if (source.measuredJsonl) {
        total.examples += source.measuredJsonl.examples;
        total.textTokens += source.measuredJsonl.textTokens;
        total.totalBytes += source.measuredJsonl.totalBytes;
      }
      if (
        (source.kind === 'image' || source.kind === 'video') &&
        source.supervisedPrompt?.trim() &&
        source.expectedAnswer?.trim()
      ) {
        total.examples += 1;
        total.textTokens += Math.max(
          1,
          Math.ceil((source.supervisedPrompt.length + source.expectedAnswer.length) / 4),
        );
        total.mediaExamples += 1;
        total.imageExamples += source.kind === 'image' ? 1 : 0;
        total.videoExamples += source.kind === 'video' ? 1 : 0;
        total.plannedVideoFrames += source.kind === 'video' ? (source.plannedFrames ?? 8) : 0;
      }
    }
    total.measured = total.examples > 0;
    return total;
  }, [sources]);
  const durationEstimate = React.useMemo(
    () =>
      method === 'knowledge' || !datasetMeasurement.measured
        ? null
        : estimateFoundryTrainingDuration({
            method,
            parametersB: selectedModel.parametersB,
            configuration: trainingConfig,
            hardware,
            measurement: datasetMeasurement,
          }),
    [datasetMeasurement, hardware, method, selectedModel.parametersB, trainingConfig],
  );

  const selectComputePreset = (presetId: TrainingComputePresetId) => {
    if (method === 'knowledge') return;
    setComputePresetId(presetId);
    setTrainingConfig((current) => applyTrainingComputePreset(method, presetId, current));
  };

  const updateAdvancedTrainingConfig = (update: Partial<FoundryTrainingConfiguration>) => {
    setComputePresetId(null);
    setTrainingConfig((current) => ({ ...current, ...update }));
  };

  const setupWeightTraining = async (includeQlora = true) => {
    setTrainingSetupBusy(true);
    setTrainingSetupError(null);
    try {
      setResolvedTrainingWorker(
        await installLocalTrainingWorker({
          includeQlora,
          ...((requestedStorageRoot ?? hardware.recommendedStorageRoot)
            ? { storageRoot: (requestedStorageRoot ?? hardware.recommendedStorageRoot)! }
            : {}),
        }),
      );
      setHardware(await detectHardware());
      setRequestedStorageRoot(null);
    } catch (caught) {
      setTrainingSetupError(caught instanceof Error ? caught.message : String(caught));
      try {
        setResolvedTrainingWorker(await getLocalTrainingWorkerStatus());
      } catch {
        // Keep the original setup error if the follow-up inspection is unavailable.
      }
    } finally {
      setTrainingSetupBusy(false);
    }
  };

  const runTrainingCalibration = async () => {
    if (method === 'knowledge' || !selectedVerifiedModel || !selectedModelInstalled) return;
    setTrainingCalibrationBusy(true);
    setError('');
    try {
      const evidence = await calibrateLocalTraining(selectedModel.id, trainingConfig);
      setTrainingCalibration({ key: calibrationKey, evidence });
      if (!evidence.qualified) setError(evidence.reason ?? 'Training calibration did not qualify.');
    } catch (caught) {
      setTrainingCalibration({
        key: calibrationKey,
        evidence: {
          qualified: false,
          modelId: selectedModel.id,
          method,
          computeDevice: trainingConfig.computeDevice,
          device: 'unknown',
          precision: 'fp32',
          forwardBackward: false,
          optimizerStep: false,
          batchSize: trainingConfig.batchSize,
          gradientAccumulation: trainingConfig.gradientAccumulation,
          maxSequenceLength: trainingConfig.maxSequenceLength,
          warmupSteps: 0,
          measuredSteps: 0,
          stepTimeMs: 0,
          stepTimeMsP95: 0,
          peakVramMb: null,
          vramTotalMb: null,
          vramHeadroomMb: null,
          elapsedMs: 0,
          reason: caught instanceof Error ? caught.message : 'Training calibration failed.',
        },
      });
      setError(caught instanceof Error ? caught.message : 'Training calibration failed.');
    } finally {
      setTrainingCalibrationBusy(false);
    }
  };

  const chooseStorageRoot = async () => {
    setTrainingSetupError(null);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        directory: true,
        multiple: false,
        title: 'Choose a drive or folder for Model Foundry',
      });
      if (typeof picked === 'string' && picked.trim()) {
        setRequestedStorageRoot(picked.trim());
      }
    } catch {
      setTrainingSetupError('The native storage picker is unavailable. Nothing was changed.');
    }
  };

  const addSourcePaths = React.useCallback(
    async (candidatePaths: readonly string[]) => {
      const paths = distinctFoundryPaths(candidatePaths);
      if (paths.length === 0) return;
      const classified = await Promise.all(
        paths.map(async (path) => {
          const source = classifySource(
            path.split(/[\\/]/).pop() ?? path,
            method,
            availableTrainingModalities,
            path,
            { transcriptionReady },
          );
          if (method !== 'knowledge' && path.toLowerCase().endsWith('.jsonl')) {
            const read = await readTextFile(path);
            if (read.ok) source.measuredJsonl = measureTrainingJsonl(read.content);
          } else if (
            method !== 'knowledge' &&
            /\.(txt|md|json|csv|ts|tsx|js|jsx|py|rs)$/iu.test(path)
          ) {
            const read = await readTextFile(path);
            if (read.ok) source.measuredJsonl = measureTrainingText(read.content);
          }
          return source;
        }),
      );
      setSources((current) => {
        const existing = new Set(
          current
            .map((source) => source.path?.replaceAll('/', '\\').toLocaleLowerCase())
            .filter(Boolean),
        );
        return [
          ...current,
          ...classified.filter((source) => {
            const identity = source.path?.replaceAll('/', '\\').toLocaleLowerCase();
            return !identity || !existing.has(identity);
          }),
        ];
      });
      setError('');
    },
    [availableTrainingModalities, method, transcriptionReady],
  );

  const addSources = async (files: FileList | null) => {
    if (!files) return;
    const paths = Array.from(files)
      .map((file) => (file as File & { path?: string }).path)
      .filter((path): path is string => Boolean(path?.trim()));
    if (paths.length !== files.length) {
      setError(
        "VibeSpace needs each file's private local path. Use Browse local files or drop files into this area in the desktop app.",
      );
      return;
    }
    await addSourcePaths(paths);
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
      await addSourcePaths(paths);
    } catch {
      setError('The native file picker is unavailable. No private file was accessed.');
    }
  };

  React.useEffect(() => {
    if (!open || step !== 3 || !isTauri) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const handler = createNativeFoundryFileDropHandler({
      devicePixelRatio: window.devicePixelRatio,
      hitTest: (clientX, clientY) => {
        const target = document.elementFromPoint(clientX, clientY);
        return Boolean(target && sourceDropZoneRef.current?.contains(target));
      },
      onHoverChange: setSourceDropActive,
      onDropPaths: (paths) => void addSourcePaths(paths),
    });
    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) =>
          handler(event.payload as NativeFoundryFileDropEvent),
        ),
      )
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => setSourceDropActive(false));
    return () => {
      disposed = true;
      setSourceDropActive(false);
      unlisten?.();
    };
  }, [addSourcePaths, open, step]);

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
          schemaVersion: method === 'knowledge' ? undefined : 2,
          name: name.trim(),
          description: description.trim(),
          purpose: purpose.trim(),
          instructions: instructions.trim() || null,
          baseModelId: selectedModel.id,
          method,
          ...(method === 'knowledge' ? {} : { trainingConfig: { ...trainingConfig, method } }),
          sourcePaths: sources
            .filter(
              (source) =>
                source.use !== 'unsupported' && source.kind !== 'image' && source.kind !== 'video',
            )
            .map((source) => source.path)
            .filter((path): path is string => Boolean(path)),
          trainingExamples:
            method === 'knowledge'
              ? []
              : sources
                  .filter(
                    (source) =>
                      source.use !== 'unsupported' &&
                      (source.kind === 'image' || source.kind === 'video') &&
                      Boolean(source.path),
                  )
                  .map((source) => ({
                    path: source.path,
                    mediaType: source.kind,
                    prompt: source.supervisedPrompt?.trim(),
                    response: source.expectedAnswer?.trim(),
                    plannedFrames: source.kind === 'video' ? (source.plannedFrames ?? 8) : 1,
                  })),
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
            ? await repairVerifiedTrainingModel(selectedVerifiedModel.id, {
                ...(requestedStorageRoot ? { storageRoot: requestedStorageRoot } : {}),
              })
            : await downloadVerifiedTrainingModel(selectedVerifiedModel.id, {
                ...(requestedStorageRoot ? { storageRoot: requestedStorageRoot } : {}),
              });
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
      const updated = await repairVerifiedTrainingModel(selectedVerifiedModel.id, {
        ...(requestedStorageRoot ? { storageRoot: requestedStorageRoot } : {}),
      });
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
      <DialogContent className="max-h-[94vh] max-w-6xl overflow-y-auto border-border/70 bg-background p-0 shadow-2xl">
        <div className="sticky top-0 z-20 border-b border-border/70 bg-background/95 px-5 py-5 backdrop-blur-xl sm:px-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="rounded-2xl border border-accent-copper/30 bg-gradient-to-br from-accent-cyan/20 to-emerald-500/10 p-2.5 text-accent-copper shadow-sm">
                <FlaskConical className="h-5 w-5" />
              </span>
              <div>
                <DialogTitle className="text-xl">Build Your Own AI</DialogTitle>
                <DialogDescription className="mt-1 max-w-2xl">
                  Create verified retrieval knowledge or supported adapter weights, processed on
                  your machine with traceable sources.
                </DialogDescription>
              </div>
            </div>
            <Button type="button" variant="ghost" className="shrink-0" onClick={() => setStep(5)}>
              View model library
            </Button>
          </div>
          <div className="mt-5 flex items-center justify-between text-metadata text-muted-foreground">
            <span>
              Step {step + 1} of {steps.length}
            </span>
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" /> Local & private
            </span>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-gradient-to-r from-accent-cyan to-emerald-400 transition-[width] duration-300 motion-reduce:transition-none"
              style={{ width: `${((step + 1) / steps.length) * 100}%` }}
            />
          </div>
          <ol className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="Model build steps">
            {steps.map((label, index) => (
              <li key={label}>
                <button
                  type="button"
                  disabled={index > step}
                  onClick={() => setStep(index)}
                  aria-current={index === step ? 'step' : undefined}
                  className={cn(
                    'flex w-full items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-metadata transition-colors',
                    index === step
                      ? 'border-accent-copper/60 bg-accent-copper/10 font-semibold text-foreground'
                      : index < step
                        ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300 hover:bg-emerald-500/10'
                        : 'cursor-not-allowed border-border/70 text-muted-foreground/70',
                  )}
                >
                  {index < step ? <Check className="h-3.5 w-3.5" /> : <span>{index + 1}.</span>}
                  {label}
                </button>
              </li>
            ))}
          </ol>
        </div>

        <div className="space-y-5 bg-gradient-to-b from-muted/10 to-transparent p-5 sm:p-7">
          {step === 0 && (
            <>
              <details
                className="rounded-lg border border-accent-copper/30 bg-accent-copper/5 p-4"
                open
              >
                <summary className="cursor-pointer font-semibold">How this works</summary>
                <ol className="mt-3 grid gap-2 text-secondary text-muted-foreground sm:grid-cols-2">
                  <li>
                    <strong className="text-foreground">1. Choose a method.</strong> Knowledge
                    searches your files; LoRA, QLoRA, and Full change model weights.
                  </li>
                  <li>
                    <strong className="text-foreground">2. Choose a base.</strong> VibeSpace shows
                    only verified checkpoints that fit the selected path.
                  </li>
                  <li>
                    <strong className="text-foreground">3. Pick a compute profile.</strong> Trade
                    memory use for speed, then review the estimate.
                  </li>
                  <li>
                    <strong className="text-foreground">4. Add sources.</strong> Documents and
                    transcripts are prepared locally and reviewed before use.
                  </li>
                  <li>
                    <strong className="text-foreground">5. Train and evaluate.</strong> The exact
                    settings, hashes, and results stay with the artifact.
                  </li>
                  <li>
                    <strong className="text-foreground">6. Promote it.</strong> Only a verified
                    completed model becomes available for use.
                  </li>
                </ol>
                <p className="mt-3 text-metadata text-muted-foreground">
                  PDF and DOCX text are extracted locally. Scanned/image-only PDFs need a verified
                  OCR processor and stay unavailable for now. MP3 and MP4 can supply local
                  transcript knowledge when the speech processor is installed. Verified SmolVLM2
                  bases can train on labeled images and sampled MP4/MOV/WebM frames alongside
                  documents. They produce text answers; image, audio, and video generation are not
                  claimed.
                </p>
              </details>
              <div>
                <h3 className="text-section-title">What are you building?</h3>
                <p className="text-secondary text-muted-foreground">
                  Default behavior is optional and remains separate from training.
                </p>
              </div>
              <Label htmlFor="foundry-purpose">Purpose</Label>
              <Textarea
                id="foundry-purpose"
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
                      disabled={trainingSetupBusy}
                      aria-pressed={method === id}
                      onClick={() => {
                        setMethod(id);
                        if (id !== 'knowledge') {
                          setComputePresetId('low-memory');
                          setTrainingConfig(defaultFoundryTrainingConfiguration(id));
                        }
                      }}
                      className={cn(
                        'rounded-lg border p-4 text-left disabled:cursor-not-allowed disabled:opacity-60',
                        method === id
                          ? 'border-accent-copper bg-accent-copper/10'
                          : 'border-border',
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
              <section className="rounded-lg border border-border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="font-semibold">Model storage</h4>
                    <p className="mt-1 text-secondary text-muted-foreground">
                      Choose C:, D:, or another local drive folder. Your computer still performs the
                      training; only the managed files move.
                    </p>
                  </div>
                  <Button type="button" variant="outline" onClick={() => void chooseStorageRoot()}>
                    Choose drive or folder
                  </Button>
                </div>
                <dl className="mt-3 space-y-1 text-secondary">
                  <div>
                    <dt className="inline text-muted-foreground">Current: </dt>
                    <dd className="inline font-mono">{hardware.storageRoot ?? 'Measuring…'}</dd>
                  </div>
                  {requestedStorageRoot && (
                    <div>
                      <dt className="inline text-muted-foreground">Selected: </dt>
                      <dd className="inline font-mono">{requestedStorageRoot}</dd>
                    </div>
                  )}
                </dl>
                {hardware.recommendedStorageRoot && !requestedStorageRoot && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="mt-2"
                    onClick={() => setRequestedStorageRoot(hardware.recommendedStorageRoot ?? null)}
                  >
                    Use recommended: {hardware.recommendedStorageRoot}
                  </Button>
                )}
                <p className="mt-2 text-metadata text-muted-foreground">
                  Applying a new location copies and verifies existing Foundry data before
                  switching. The old copy is retained for recovery. Knowledge models managed by
                  Ollama remain under Ollama’s own local storage.
                </p>
                {requestedStorageRoot && effectiveTrainingWorker?.attested && (
                  <Button
                    type="button"
                    variant="accent"
                    className="mt-3"
                    disabled={trainingSetupBusy}
                    onClick={() => void setupWeightTraining()}
                  >
                    {trainingSetupBusy
                      ? 'Verifying and switching…'
                      : 'Apply storage and verify runtime'}
                  </Button>
                )}
              </section>
              {(!effectiveTrainingWorker?.attested ||
                (method !== 'knowledge' && !effectiveTrainingWorker.methods.includes(method))) && (
                <section className="rounded-lg border border-border p-4">
                  <h4 className="font-semibold">Unlock verified weight training</h4>
                  <p className="mt-1 text-secondary text-muted-foreground">
                    Install the private, hash-checked worker and test this computer for LoRA, QLoRA,
                    and Full support. This downloads dependencies; your source files stay local.
                    Unsupported methods remain blocked from starting, with a reason.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-3"
                    disabled={trainingSetupBusy}
                    onClick={() => void setupWeightTraining()}
                  >
                    {trainingSetupBusy
                      ? 'Setting up verified training…'
                      : 'Set up LoRA, QLoRA, and Full'}
                  </Button>
                  {trainingSetupError && (
                    <p className="mt-2 text-secondary text-amber-300">{trainingSetupError}</p>
                  )}
                </section>
              )}
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
                <span className="break-all">
                  Managed storage: {hardware.storageRoot ?? 'Application data (default)'}
                </span>
                {hardware.recommendedStorageRoot && (
                  <span className="break-all text-emerald-300">
                    Storage recommendation: {hardware.recommendedStorageRoot}
                  </span>
                )}
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
                          ? 'border-accent-copper bg-accent-copper/10'
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
                        {(model.modalities ?? ['text']).map((modality) => (
                          <span
                            key={modality}
                            className="rounded bg-accent-copper/10 px-2 py-0.5 text-metadata text-accent-copper"
                          >
                            {modality}
                          </span>
                        ))}
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
                      {(model.modalities?.includes('image') ||
                        model.modalities?.includes('video')) && (
                        <p className="mt-1 text-secondary text-muted-foreground">
                          Understands labeled image/video examples and produces text answers. It
                          does not generate image or video files.
                        </p>
                      )}
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
                <div className="rounded-lg border border-accent-copper/30 bg-accent-copper/5 p-4">
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
              {method !== 'knowledge' && (
                <div className="space-y-4">
                  <section
                    className="rounded-lg border border-border p-4"
                    aria-labelledby="foundry-compute-profile"
                  >
                    <h4 id="foundry-compute-profile" className="font-semibold">
                      Choose speed and memory use
                    </h4>
                    <p className="mt-1 text-secondary text-muted-foreground">
                      Start with a profile, then use Advanced settings only if you want exact
                      control.
                    </p>
                    <div className="mt-3" role="group" aria-label="Training device">
                      <p className="text-metadata font-medium text-muted-foreground">
                        Model compute device
                      </p>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        {(
                          [
                            [
                              'gpu',
                              'GPU only',
                              'Requires CUDA and never falls back to CPU training.',
                            ],
                            ['cpu', 'CPU only', 'Uses CPU training even when a GPU is present.'],
                          ] as const
                        ).map(([device, label, copy]) => (
                          <button
                            key={device}
                            type="button"
                            disabled={method === 'qlora' && device === 'cpu'}
                            aria-pressed={trainingConfig.computeDevice === device}
                            onClick={() =>
                              setTrainingConfig((current) => ({
                                ...current,
                                computeDevice: device,
                              }))
                            }
                            className={cn(
                              'rounded-lg border p-3 text-left transition-colors',
                              trainingConfig.computeDevice === device
                                ? 'border-accent-copper bg-accent-copper/10'
                                : 'border-border hover:bg-muted',
                            )}
                          >
                            <strong className="block">{label}</strong>
                            <span className="mt-1 block text-metadata text-muted-foreground">
                              {copy}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-3">
                      {TRAINING_COMPUTE_PRESETS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          aria-pressed={computePresetId === preset.id}
                          onClick={() => selectComputePreset(preset.id)}
                          className={cn(
                            'rounded-lg border p-3 text-left transition-colors',
                            computePresetId === preset.id
                              ? 'border-accent-copper bg-accent-copper/10'
                              : 'border-border hover:bg-muted',
                          )}
                        >
                          <strong className="block">{preset.label}</strong>
                          <span className="mt-1 block text-metadata text-muted-foreground">
                            {preset.summary}
                          </span>
                        </button>
                      ))}
                    </div>
                    {durationEstimate && (
                      <div className="mt-3 rounded-md bg-muted/60 p-3" aria-live="polite">
                        <p className="font-medium">
                          Estimated training time: {durationEstimate.minimumHours}–
                          {durationEstimate.maximumHours} hours
                        </p>
                        <p className="mt-1 text-metadata text-muted-foreground">
                          {durationEstimate.basis} {durationEstimate.disclaimer}
                        </p>
                      </div>
                    )}
                    {!durationEstimate && (
                      <p className="mt-3 rounded-md bg-muted/60 p-3 text-secondary text-muted-foreground">
                        Add readable text/JSONL data or at least two labeled image/video examples to
                        receive a measured prediction. PDF/DOCX size is finalized during private
                        local preparation.
                      </p>
                    )}
                  </section>
                  <details className="rounded-lg border border-border p-4">
                    <summary className="cursor-pointer font-semibold">
                      Advanced reproducible settings{computePresetId === null ? ' · Custom' : ''}
                    </summary>
                    <p className="mt-2 text-secondary text-muted-foreground">
                      These exact requested values are validated locally and recorded with the final
                      artifact. Blank maximum steps means the epoch limit controls the run.
                    </p>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <Label htmlFor="foundry-seed">Seed</Label>
                        <Input
                          id="foundry-seed"
                          type="number"
                          min={0}
                          step={1}
                          value={numericInputValue(trainingConfig.seed)}
                          onChange={(event) =>
                            updateAdvancedTrainingConfig({
                              seed: event.currentTarget.valueAsNumber,
                            })
                          }
                        />
                      </div>
                      <div>
                        <Label htmlFor="foundry-epochs">Epochs</Label>
                        <Input
                          id="foundry-epochs"
                          type="number"
                          min={1}
                          max={20}
                          step={1}
                          value={numericInputValue(trainingConfig.epochs)}
                          onChange={(event) =>
                            updateAdvancedTrainingConfig({
                              epochs: event.currentTarget.valueAsNumber,
                            })
                          }
                        />
                      </div>
                      <div>
                        <Label htmlFor="foundry-max-steps">Maximum steps (optional)</Label>
                        <Input
                          id="foundry-max-steps"
                          type="number"
                          min={1}
                          max={1_000_000}
                          step={1}
                          value={trainingConfig.maxSteps ?? ''}
                          onChange={(event) =>
                            updateAdvancedTrainingConfig({
                              maxSteps: event.currentTarget.value
                                ? event.currentTarget.valueAsNumber
                                : undefined,
                            })
                          }
                        />
                      </div>
                      <div>
                        <Label htmlFor="foundry-learning-rate">Learning rate</Label>
                        <Input
                          id="foundry-learning-rate"
                          type="number"
                          min={0.000_000_01}
                          max={1}
                          step="any"
                          value={numericInputValue(trainingConfig.learningRate)}
                          onChange={(event) =>
                            updateAdvancedTrainingConfig({
                              learningRate: event.currentTarget.valueAsNumber,
                            })
                          }
                        />
                      </div>
                      <div>
                        <Label htmlFor="foundry-batch-size">Batch size</Label>
                        <Input
                          id="foundry-batch-size"
                          type="number"
                          min={1}
                          max={128}
                          step={1}
                          value={numericInputValue(trainingConfig.batchSize)}
                          onChange={(event) =>
                            updateAdvancedTrainingConfig({
                              batchSize: event.currentTarget.valueAsNumber,
                            })
                          }
                        />
                      </div>
                      <div>
                        <Label htmlFor="foundry-gradient-accumulation">Gradient accumulation</Label>
                        <Input
                          id="foundry-gradient-accumulation"
                          type="number"
                          min={1}
                          max={1_024}
                          step={1}
                          value={numericInputValue(trainingConfig.gradientAccumulation)}
                          onChange={(event) =>
                            updateAdvancedTrainingConfig({
                              gradientAccumulation: event.currentTarget.valueAsNumber,
                            })
                          }
                        />
                      </div>
                      <div>
                        <Label htmlFor="foundry-sequence-length">Maximum sequence length</Label>
                        <Input
                          id="foundry-sequence-length"
                          type="number"
                          min={64}
                          max={131_072}
                          step={1}
                          value={numericInputValue(trainingConfig.maxSequenceLength)}
                          onChange={(event) =>
                            updateAdvancedTrainingConfig({
                              maxSequenceLength: event.currentTarget.valueAsNumber,
                            })
                          }
                        />
                      </div>
                      {method !== 'full' && (
                        <>
                          <div>
                            <Label htmlFor="foundry-lora-rank">LoRA rank</Label>
                            <Input
                              id="foundry-lora-rank"
                              type="number"
                              min={1}
                              max={1_024}
                              step={1}
                              value={numericInputValue(trainingConfig.loraRank)}
                              onChange={(event) =>
                                updateAdvancedTrainingConfig({
                                  loraRank: event.currentTarget.valueAsNumber,
                                })
                              }
                            />
                          </div>
                          <div>
                            <Label htmlFor="foundry-lora-alpha">LoRA alpha</Label>
                            <Input
                              id="foundry-lora-alpha"
                              type="number"
                              min={1}
                              max={8_192}
                              step={1}
                              value={numericInputValue(trainingConfig.loraAlpha)}
                              onChange={(event) =>
                                updateAdvancedTrainingConfig({
                                  loraAlpha: event.currentTarget.valueAsNumber,
                                })
                              }
                            />
                          </div>
                          <div>
                            <Label htmlFor="foundry-lora-dropout">LoRA dropout</Label>
                            <Input
                              id="foundry-lora-dropout"
                              type="number"
                              min={0}
                              max={0.999}
                              step="any"
                              value={numericInputValue(trainingConfig.loraDropout)}
                              onChange={(event) =>
                                updateAdvancedTrainingConfig({
                                  loraDropout: event.currentTarget.valueAsNumber,
                                })
                              }
                            />
                          </div>
                        </>
                      )}
                    </div>
                    {validateFoundryTrainingConfiguration(trainingConfig) && (
                      <p className="mt-3 text-secondary text-amber-300">
                        {validateFoundryTrainingConfiguration(trainingConfig)}
                      </p>
                    )}
                  </details>
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <>
              <div
                ref={sourceDropZoneRef}
                data-testid="foundry-source-drop-zone"
                data-foundry-drop-zone="true"
                onDragEnter={(event) => {
                  event.preventDefault();
                  setSourceDropActive(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'copy';
                  setSourceDropActive(true);
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setSourceDropActive(false);
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setSourceDropActive(false);
                  void addSources(event.dataTransfer.files);
                }}
                className={cn(
                  'relative overflow-hidden rounded-2xl border-2 border-dashed p-7 text-center transition-colors sm:p-10',
                  sourceDropActive
                    ? 'border-accent-copper bg-accent-copper/10 shadow-[0_0_40px_-20px_hsl(var(--accent-cyan)/0.65)]'
                    : 'border-border bg-muted/20 hover:border-accent-copper/50 hover:bg-accent-copper/5',
                )}
              >
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-accent-copper/30 bg-accent-copper/10 text-accent-copper">
                  <Upload className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-section-title">
                  {sourceDropActive
                    ? 'Release to attach your local files'
                    : 'Drop training references here'}
                </h3>
                <p className="mx-auto mt-2 max-w-xl text-secondary text-muted-foreground">
                  Add documents, code, datasets, images, audio, or video. VibeSpace validates every
                  format and explains exactly how it will be used.
                </p>
                <Button
                  type="button"
                  variant="accent"
                  className="mt-5"
                  onClick={() => void pickLocalSources()}
                >
                  Browse local files
                </Button>
                <div className="mt-5 flex flex-wrap justify-center gap-2 text-metadata text-muted-foreground">
                  {['TXT / MD / PDF', 'JSONL / CODE', 'IMAGE', 'MP3 / AUDIO', 'MP4 / VIDEO'].map(
                    (format) => (
                      <span
                        key={format}
                        className="rounded-full border border-border bg-background/60 px-2.5 py-1"
                      >
                        {format}
                      </span>
                    ),
                  )}
                </div>
              </div>
              <label className="sr-only">
                Browser fallback source picker
                <input
                  type="file"
                  multiple
                  onChange={(event) => void addSources(event.target.files)}
                />
              </label>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5 text-secondary text-muted-foreground">
                <span className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-emerald-400" /> Files stay local. Nothing is
                  uploaded without separate permission.
                </span>
                <span>{sources.length} attached</span>
              </div>
              {sources.map((source, index) => (
                <div
                  key={`${source.name}-${index}`}
                  className={cn(
                    'rounded-xl border p-4 shadow-sm',
                    source.use === 'unsupported'
                      ? 'border-amber-500/30 bg-amber-500/5'
                      : 'border-border bg-background/60',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 shrink-0 text-accent-copper" />
                        <strong className="truncate">{source.name}</strong>
                        <span className="rounded-full border border-accent-copper/20 bg-accent-copper/5 px-2 py-0.5 text-metadata uppercase text-accent-copper">
                          {source.use.replace('_', ' ')}
                        </span>
                      </div>
                      {source.path && (
                        <p
                          className="mt-1 truncate font-mono text-metadata text-muted-foreground"
                          title={source.path}
                        >
                          {source.path}
                        </p>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${source.name}`}
                      onClick={() =>
                        setSources((current) =>
                          current.filter((_, sourceIndex) => sourceIndex !== index),
                        )
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="mt-2 text-secondary text-muted-foreground">{source.explanation}</p>
                  {method !== 'knowledge' &&
                    source.use !== 'unsupported' &&
                    (source.kind === 'image' || source.kind === 'video') && (
                      <div className="mt-3 grid gap-3">
                        <div>
                          <Label htmlFor={`foundry-media-prompt-${index}`}>
                            Training question or instruction
                          </Label>
                          <Textarea
                            id={`foundry-media-prompt-${index}`}
                            value={source.supervisedPrompt ?? ''}
                            placeholder="For example: What is happening in this clip?"
                            onChange={(event) =>
                              setSources((current) =>
                                current.map((candidate, candidateIndex) =>
                                  candidateIndex === index
                                    ? { ...candidate, supervisedPrompt: event.target.value }
                                    : candidate,
                                ),
                              )
                            }
                          />
                        </div>
                        <div>
                          <Label htmlFor={`foundry-media-answer-${index}`}>Expected answer</Label>
                          <Textarea
                            id={`foundry-media-answer-${index}`}
                            value={source.expectedAnswer ?? ''}
                            placeholder="Write the answer the model should learn."
                            onChange={(event) =>
                              setSources((current) =>
                                current.map((candidate, candidateIndex) =>
                                  candidateIndex === index
                                    ? { ...candidate, expectedAnswer: event.target.value }
                                    : candidate,
                                ),
                              )
                            }
                          />
                        </div>
                        {source.kind === 'video' && (
                          <div>
                            <Label htmlFor={`foundry-video-frames-${index}`}>
                              Frames sampled across the clip (1–32)
                            </Label>
                            <Input
                              id={`foundry-video-frames-${index}`}
                              type="number"
                              min={1}
                              max={32}
                              value={source.plannedFrames ?? 8}
                              onChange={(event) =>
                                setSources((current) =>
                                  current.map((candidate, candidateIndex) =>
                                    candidateIndex === index
                                      ? {
                                          ...candidate,
                                          plannedFrames: Math.max(
                                            1,
                                            Math.min(32, event.currentTarget.valueAsNumber || 8),
                                          ),
                                        }
                                      : candidate,
                                  ),
                                )
                              }
                            />
                            <p className="mt-1 text-metadata text-muted-foreground">
                              More frames can capture more of the clip but use more memory and time.
                            </p>
                          </div>
                        )}
                      </div>
                    )}
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
              {durationEstimate && (
                <div>
                  <p>
                    Planning estimate: {durationEstimate.minimumHours}–
                    {durationEstimate.maximumHours} hours ·{' '}
                    {durationEstimate.optimizationSteps.toLocaleString()} optimization steps.
                  </p>
                  <p className="mt-1 text-metadata text-muted-foreground">
                    {durationEstimate.basis} {durationEstimate.disclaimer}
                  </p>
                </div>
              )}
              {method !== 'knowledge' && (
                <div className="rounded-lg border border-border bg-background/40 p-3" role="status">
                  <p className="font-medium">
                    {trainingConfig.computeDevice.toUpperCase()} method calibration
                  </p>
                  <p className="mt-1 text-secondary text-muted-foreground">
                    Loads the verified local model at the selected batch, context, and gradient
                    settings, then proves forward, backward, and optimizer steps on the selected
                    device. No artifact is created.
                  </p>
                  {matchingCalibration?.qualified ? (
                    <p className="mt-2 text-emerald-300">
                      Qualified: {matchingCalibration.method.toUpperCase()} on{' '}
                      {matchingCalibration.device} · {matchingCalibration.precision.toUpperCase()} ·{' '}
                      {matchingCalibration.elapsedMs} ms · {matchingCalibration.batchSize} ×{' '}
                      {matchingCalibration.maxSequenceLength} tokens · grad{' '}
                      {matchingCalibration.gradientAccumulation} · {matchingCalibration.stepTimeMs}{' '}
                      ms/step (P95 {matchingCalibration.stepTimeMsP95} ms ·{' '}
                      {matchingCalibration.warmupSteps} warmup + {matchingCalibration.measuredSteps}{' '}
                      measured)
                      {matchingCalibration.peakVramMb === null
                        ? ''
                        : ` · peak VRAM ${matchingCalibration.peakVramMb} MB${
                            matchingCalibration.vramHeadroomMb === null
                              ? ''
                              : ` · headroom ${matchingCalibration.vramHeadroomMb} MB`
                          }`}
                    </p>
                  ) : (
                    <p className="mt-2 text-amber-300">
                      {matchingCalibration?.reason ??
                        'Calibration is required before Start Training.'}
                    </p>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-3"
                    disabled={trainingCalibrationBusy || !selectedModelInstalled}
                    onClick={() => void runTrainingCalibration()}
                  >
                    {trainingCalibrationBusy ? 'Calibrating…' : 'Run calibration'}
                  </Button>
                </div>
              )}
              {startError && <p className="text-amber-300">{startError}</p>}
            </div>
          )}

          {step === 5 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-accent-copper" />
                <h3 className="text-section-title">Persistent model jobs</h3>
              </div>
              {jobs.length === 0 ? (
                <p className="text-muted-foreground">No verified job has started.</p>
              ) : (
                jobs.map((job) => (
                  <div
                    key={job.id}
                    className={cn(
                      'rounded-xl border bg-background/60 p-4 shadow-sm',
                      revealJobId === job.id
                        ? 'animate-scale-in border-accent-copper bg-accent-copper/5'
                        : job.status === 'failed'
                          ? 'border-destructive/40 bg-destructive/5'
                          : 'border-border',
                    )}
                  >
                    {revealJobId === job.id && (
                      <p className="mb-2 text-metadata font-semibold uppercase tracking-wider text-accent-copper">
                        Your verified local model is ready
                      </p>
                    )}
                    <div className="flex items-center justify-between gap-3">
                      <strong className="truncate">{job.name}</strong>
                      <span
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-metadata font-semibold uppercase tracking-wide',
                          job.status === 'failed'
                            ? 'border-destructive/40 bg-destructive/10 text-destructive'
                            : job.status === 'completed'
                              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                              : 'border-accent-copper/30 bg-accent-copper/10 text-accent-copper',
                        )}
                      >
                        {job.status}
                      </span>
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded bg-muted">
                      <div
                        className={cn(
                          'h-full transition-[width] motion-reduce:transition-none',
                          job.status === 'failed' ? 'bg-destructive' : 'bg-accent-copper',
                        )}
                        style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }}
                      />
                    </div>
                    <p className="mt-2 text-secondary text-muted-foreground">
                      v{job.version ?? 1} · {job.progress}% ·{' '}
                      {job.status === 'failed' &&
                      job.error?.toLocaleLowerCase().includes('source provenance')
                        ? 'Source verification incomplete'
                        : `${job.sourceCount ?? 0} verified sources`}{' '}
                      ·{' '}
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
                    {job.status === 'failed' &&
                      job.error?.toLocaleLowerCase().includes('source provenance') && (
                        <div className="mt-3 flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-secondary">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                          <div>
                            <strong className="text-foreground">Retry this job</strong>
                            <p className="mt-1 text-muted-foreground">
                              The earlier packager counted selected files instead of the sources
                              that contributed verified content. Retry revalidates the local files,
                              excludes empty or duplicate content, and records the exact provenance
                              count before creating the artifact.
                            </p>
                          </div>
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
              className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-secondary text-destructive"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="sticky bottom-0 z-10 -mx-5 -mb-5 flex items-center justify-between border-t border-border/70 bg-background/95 px-5 py-4 backdrop-blur-xl sm:-mx-7 sm:-mb-7 sm:px-7">
            <Button
              variant="ghost"
              disabled={step === 0}
              onClick={() => setStep((current) => Math.max(0, current - 1))}
            >
              Back
            </Button>
            <span className="hidden text-metadata text-muted-foreground sm:block">
              {steps[step]}
            </span>
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
