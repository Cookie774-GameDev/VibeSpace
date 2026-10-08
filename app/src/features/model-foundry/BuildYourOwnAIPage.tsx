import * as React from 'react';
import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  Cpu,
  Database,
  FlaskConical,
  Gauge,
  HardDrive,
  Image,
  Library,
  LockKeyhole,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Video,
  Volume2,
  WandSparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { BuildYourOwnAIHub, detectHardware } from './BuildYourOwnAIHub';
import { FoundryPage } from './FoundryPage';
import {
  formatFoundryStorageBytes,
  loadJobs,
  type FoundryJob,
  type HardwareProfile,
  type TrainingMethod,
} from './modelHub';
import {
  getLocalTrainingWorkerStatus,
  installLocalTrainingWorker,
  type LocalTrainingWorkerStatus,
} from './trainingRuntime';

const SECTIONS = [
  { id: 'overview', label: 'Overview', icon: BrainCircuit },
  { id: 'create', label: 'Create', icon: WandSparkles },
  { id: 'data', label: 'Data Studio', icon: Database },
  { id: 'train', label: 'Train', icon: Play },
  { id: 'evaluate', label: 'Evaluate', icon: FlaskConical },
  { id: 'models', label: 'My Models', icon: Library },
  { id: 'studio', label: 'Foundry Studio', icon: Sparkles },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

const INITIAL_HARDWARE: HardwareProfile = {
  cpu: 'Detecting local hardware…',
  gpu: null,
  ramGb: 0,
  vramGb: 0,
  freeStorageGb: 0,
  os: 'Detecting…',
  accelerators: [],
};

function statusLabel(job: FoundryJob): string {
  return job.status.replace('_', ' ');
}

function activeJobs(jobs: readonly FoundryJob[]): number {
  return jobs.filter((job) =>
    ['queued', 'validating', 'preparing', 'training', 'evaluating', 'packaging'].includes(
      job.status,
    ),
  ).length;
}

function verifiedJobs(jobs: readonly FoundryJob[]): FoundryJob[] {
  return jobs.filter(
    (job) => job.status === 'completed' && job.artifactVerified === true && job.artifactPath,
  );
}

function Blueprint() {
  const stages = [
    { label: 'Private sources', icon: Database, detail: 'Local files' },
    { label: 'Prepare', icon: WandSparkles, detail: 'Clean and structure' },
    { label: 'Train', icon: BrainCircuit, detail: 'Local GPU or CPU' },
    { label: 'Verify', icon: ShieldCheck, detail: 'Evaluate and hash' },
  ] as const;

  return (
    <section
      aria-label="Local model blueprint"
      className="relative overflow-hidden rounded-2xl border border-border bg-card p-4 shadow-soft [html[data-theme=monochrome]_&]:shadow-none"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,hsl(var(--accent-cyan)/0.12),transparent_55%)]" />
      <div className="relative mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-metadata font-semibold uppercase tracking-[0.18em] text-accent-copper">
            Local model blueprint
          </p>
          <h2 className="mt-1 font-display text-section-title text-foreground">
            See exactly how your model is built
          </h2>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/70 px-3 py-1 text-metadata text-muted-foreground">
          <LockKeyhole className="h-3.5 w-3.5 text-accent-copper" />
          No cloud upload
        </span>
      </div>
      <div className="relative grid grid-cols-2 gap-2.5 xl:grid-cols-4">
        {stages.map((stage, index) => {
          const Icon = stage.icon;
          return (
            <React.Fragment key={stage.label}>
              <div className="relative z-[1] rounded-xl border border-border/80 bg-background/85 p-3 backdrop-blur-sm">
                <div className="mb-2 flex items-center justify-between">
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent-copper/10 text-accent-copper">
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  <span className="font-mono text-metadata text-muted-foreground">
                    0{index + 1}
                  </span>
                </div>
                <h3 className="font-medium text-foreground">{stage.label}</h3>
                <p className="mt-1 text-secondary text-muted-foreground">{stage.detail}</p>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </section>
  );
}

function Overview({
  jobs,
  onCreate,
  onOpenSection,
  onChooseMethod,
  trainingWorker,
  trainingWorkerChecking,
  trainingWorkerError,
}: {
  jobs: readonly FoundryJob[];
  onCreate(): void;
  onOpenSection(section: SectionId): void;
  onChooseMethod(method: TrainingMethod): void;
  trainingWorker: LocalTrainingWorkerStatus | null;
  trainingWorkerChecking: boolean;
  trainingWorkerError: string | null;
}) {
  const completed = verifiedJobs(jobs);
  return (
    <div className="space-y-4" data-warm-surface="model-foundry-overview">
      <div className="relative overflow-hidden rounded-2xl border border-accent-copper/25 bg-card/90 p-5 shadow-soft sm:p-6">
        <p className="text-metadata font-semibold uppercase tracking-[0.18em] text-accent-copper">
          Your private model workshop
        </p>
        <h1 className="mt-2 font-display text-hero text-foreground">Build Your Own AI</h1>
        <p className="mt-2 max-w-xl text-body text-muted-foreground">
          Add knowledge, prepare examples, train compatible models, and verify the result without
          sending your source files away.
        </p>
        <Button className="mt-4" variant="accent" size="sm" onClick={onCreate}>
          <Sparkles className="h-4 w-4" />
          Create a local model
        </Button>
      </div>

      <section aria-labelledby="foundry-paths-heading">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="foundry-paths-heading" className="font-display text-section-title">
            Choose how deeply to customize
          </h2>
          <button
            type="button"
            className="text-secondary font-medium text-accent-copper hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-copper"
            onClick={() => onOpenSection('train')}
          >
            Compare methods
          </button>
        </div>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          {[
            {
              title: 'Add knowledge',
              technical: 'RAG',
              description: 'Fastest path. Search private sources without changing model weights.',
              method: 'knowledge' as const,
              section: 'create' as const,
            },
            {
              title: 'Teach a specialty',
              technical: 'LoRA',
              description: 'Train a small adapter when a verified worker and compatible GPU fit.',
              method: 'lora' as const,
              section: 'train' as const,
            },
            {
              title: 'Train efficiently',
              technical: 'QLoRA',
              description: 'Use quantized training to lower memory needs on supported hardware.',
              method: 'qlora' as const,
              section: 'train' as const,
            },
            {
              title: 'Train all weights',
              technical: 'Full weight',
              description: 'Available only for small models that safely fit the detected machine.',
              method: 'full' as const,
              section: 'train' as const,
            },
          ].map((method) => (
            <button
              key={method.technical}
              type="button"
              className="flex h-full min-w-0 flex-col rounded-xl border border-border bg-card p-3 text-left transition-[border-color,transform,box-shadow] hover:-translate-y-0.5 hover:border-accent-copper/40 hover:shadow-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-copper"
              aria-label={`${method.technical}: ${method.title}`}
              onClick={() => onChooseMethod(method.method)}
            >
              <div className="flex min-h-9 flex-wrap items-start justify-between gap-1">
                <span className="rounded-full bg-muted px-2 py-1 font-mono text-metadata text-muted-foreground">
                  {method.technical}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 text-metadata',
                    method.method === 'knowledge' ||
                      (trainingWorker?.installed && trainingWorker.attested && trainingWorker.methods.includes(method.method))
                      ? 'text-accent-copper'
                      : 'text-muted-foreground',
                  )}
                >
                  {method.method === 'knowledge' ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <Gauge className="h-3.5 w-3.5" />
                  )}
                  {method.method === 'knowledge'
                    ? 'No weight training'
                    : trainingWorkerChecking
                      ? 'Checking worker'
                      : trainingWorkerError || !trainingWorker
                        ? 'Status unknown'
                        : trainingWorker.installed && trainingWorker.attested && trainingWorker.methods.includes(method.method)
                      ? 'Worker ready'
                      : 'Setup required'}
                </span>
              </div>
              <h3 className="mt-2 font-display text-sm font-semibold leading-tight text-foreground">
                {method.title}
              </h3>
              <p className="mt-1 flex-1 text-xs leading-snug text-muted-foreground">
                {method.description}
              </p>
              <span className="mt-3 inline-flex items-center gap-1 border-t border-border/70 pt-2 text-xs font-medium text-accent-copper">
                Configure {method.technical}
                <ChevronRight className="h-3.5 w-3.5" />
              </span>
            </button>
          ))}
        </div>
      </section>

      <Blueprint />

      {completed.length ? (
        <section className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-section-title">Ready to use</h2>
              <p className="text-secondary text-muted-foreground">
                {completed.length} verified local {completed.length === 1 ? 'model' : 'models'}
              </p>
            </div>
            <Button variant="ghost" onClick={() => onOpenSection('models')}>
              Open model library
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function SectionContent({
  section,
  jobs,
  onCreate,
}: {
  section: SectionId;
  jobs: readonly FoundryJob[];
  onCreate(): void;
}) {
  if (section === 'studio') {
    return <FoundryPage />;
  }
  if (section === 'create') {
    return (
      <div className="mx-auto max-w-3xl py-8 text-center">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-accent-copper/10 text-accent-copper">
          <WandSparkles className="h-6 w-6" />
        </span>
        <h1 className="mt-5 font-display text-hero">Start with a purpose</h1>
        <p className="mx-auto mt-2 max-w-xl text-body text-muted-foreground">
          VibeSpace will measure this computer, recommend a compatible base model, and explain every
          source before processing begins.
        </p>
        <Button className="mt-6" variant="accent" size="lg" onClick={onCreate}>
          Create a local model
        </Button>
      </div>
    );
  }
  if (section === 'data') {
    return (
      <div className="space-y-5">
        <div>
          <p className="text-metadata font-semibold uppercase tracking-[0.18em] text-accent-copper">
            Data Studio
          </p>
          <h1 className="mt-2 font-display text-hero">Prepare private training data</h1>
          <p className="mt-2 max-w-2xl text-body text-muted-foreground">
            Review images, video, audio, documents, code, and datasets before a local worker uses
            them. Originals remain untouched.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {[
            { icon: Image, title: 'Images', copy: 'Validate, resize, caption, and label locally.' },
            { icon: Video, title: 'Video', copy: 'Sample bounded frames and align timestamps.' },
            { icon: Volume2, title: 'Audio', copy: 'Transcribe or prepare native audio examples.' },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <article key={item.title} className="rounded-xl border border-border bg-card p-5">
                <Icon className="h-5 w-5 text-accent-copper" />
                <h2 className="mt-5 font-medium">{item.title}</h2>
                <p className="mt-1 text-secondary text-muted-foreground">{item.copy}</p>
              </article>
            );
          })}
        </div>
        <Button variant="accent" onClick={onCreate}>
          Choose sources
        </Button>
      </div>
    );
  }
  if (section === 'train') {
    return (
      <div className="space-y-5">
        <div>
          <p className="text-metadata font-semibold uppercase tracking-[0.18em] text-accent-copper">
            Training
          </p>
          <h1 className="mt-2 font-display text-hero">Use only what this computer can run</h1>
          <p className="mt-2 max-w-2xl text-body text-muted-foreground">
            RAG, LoRA, QLoRA, and full-weight training stay distinct. VibeSpace never silently
            substitutes one method for another.
          </p>
        </div>
        <Blueprint />
        <Button variant="accent" onClick={onCreate}>
          Configure training
        </Button>
      </div>
    );
  }
  if (section === 'evaluate') {
    return (
      <div className="mx-auto max-w-3xl py-8">
        <FlaskConical className="h-7 w-7 text-accent-copper" />
        <h1 className="mt-5 font-display text-hero">Evaluate before activation</h1>
        <p className="mt-2 text-body text-muted-foreground">
          Review job outcomes and artifact integrity here. A verified file is not a guarantee of
          answer quality: inspect held-out evaluation results before using a model for real work.
        </p>
        <div className="mt-6 rounded-xl border border-border bg-card p-5">
          <p className="text-secondary text-muted-foreground">
            {jobs.length
              ? `${jobs.length} local jobs · ${verifiedJobs(jobs).length} verified artifacts`
              : 'No job results yet. Create a model to begin.'}
          </p>
        </div>
        <div className="mt-4 space-y-3">
          {jobs.map((job) => (
            <article key={job.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-medium">{job.name}</h2>
                <span className="text-metadata text-muted-foreground">{statusLabel(job)}</span>
              </div>
              <p className="mt-2 text-secondary text-muted-foreground">
                {job.artifactVerified && job.artifactPath && job.status === 'completed'
                  ? 'Artifact integrity verified'
                  : 'Artifact not yet verified'}
              </p>
              {job.error && <p className="mt-2 text-secondary text-destructive">{job.error}</p>}
            </article>
          ))}
        </div>
        <Button className="mt-5" variant="accent" onClick={onCreate}>
          Open jobs and artifacts
        </Button>
      </div>
    );
  }

  const models = verifiedJobs(jobs);
  return (
    <div className="space-y-5">
      <div>
        <p className="text-metadata font-semibold uppercase tracking-[0.18em] text-accent-copper">
          Local library
        </p>
        <h1 className="mt-2 font-display text-hero">My Models</h1>
        <p className="mt-2 text-body text-muted-foreground">
          Only completed, integrity-verified artifacts can appear here.
        </p>
      </div>
      {models.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <Library className="mx-auto h-6 w-6 text-muted-foreground" />
          <h2 className="mt-4 font-medium">No verified models yet</h2>
          <p className="mt-1 text-secondary text-muted-foreground">
            Create a knowledge model to populate your private library.
          </p>
          <Button className="mt-5" variant="accent" onClick={onCreate}>
            Create a local model
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {models.map((job) => (
            <article key={job.id} className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-medium">{job.name}</h2>
                  <p className="mt-1 text-secondary text-muted-foreground">{job.baseModelId}</p>
                </div>
                <CheckCircle2 className="h-5 w-5 text-success" />
              </div>
              <p className="mt-5 font-mono text-metadata text-muted-foreground">
                {formatFoundryStorageBytes(job.storageBytes)} · SHA-256 verified
              </p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export function BuildYourOwnAIPage() {
  const [section, setSection] = React.useState<SectionId>('overview');
  const [builderOpen, setBuilderOpen] = React.useState(false);
  const [initialMethod, setInitialMethod] = React.useState<TrainingMethod>();
  const [hardware, setHardware] = React.useState<HardwareProfile>(INITIAL_HARDWARE);
  const [trainingWorker, setTrainingWorker] = React.useState<LocalTrainingWorkerStatus | null>(
    null,
  );
  const [trainingWorkerBusy, setTrainingWorkerBusy] = React.useState(false);
  const [trainingWorkerError, setTrainingWorkerError] = React.useState<string | null>(null);
  const [trainingWorkerChecking, setTrainingWorkerChecking] = React.useState(true);
  const workerInspectionMounted = React.useRef(false);
  const workerInspectionPending = React.useRef(false);
  const workerInspectionRevision = React.useRef(0);
  const inspectTrainingWorker = React.useCallback(async () => {
    if (!workerInspectionMounted.current || workerInspectionPending.current) return;
    workerInspectionPending.current = true;
    const revision = ++workerInspectionRevision.current;
    const isCurrent = () => workerInspectionMounted.current && workerInspectionRevision.current === revision;
    setTrainingWorkerChecking(true);
    setTrainingWorkerError(null);
    setTrainingWorker(null);
    try {
      const status = await getLocalTrainingWorkerStatus();
      if (isCurrent()) setTrainingWorker(status);
    } catch (error: unknown) {
      if (isCurrent()) setTrainingWorkerError(
        error instanceof Error ? error.message : 'Could not inspect the local training worker.',
      );
    } finally {
      if (isCurrent()) {
        workerInspectionPending.current = false;
        setTrainingWorkerChecking(false);
      }
    }
  }, []);
  const [jobs, setJobs] = React.useState<FoundryJob[]>(() =>
    typeof window === 'undefined' ? [] : loadJobs(window.localStorage),
  );

  React.useEffect(() => {
    let cancelled = false;
    void detectHardware().then((profile) => {
      if (!cancelled) setHardware(profile);
    });
    let refreshing = false;
    const refreshJobs = async () => {
      if (cancelled || refreshing) return;
      refreshing = true;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const nativeJobs = await invoke<FoundryJob[]>('model_foundry_list_jobs');
        if (!cancelled && Array.isArray(nativeJobs)) setJobs(nativeJobs);
      } catch {
        // Keep the last known snapshot; never fabricate a completed job.
      } finally {
        refreshing = false;
      }
    };
    void refreshJobs();
    const timer = window.setInterval(() => {
      void refreshJobs();
    }, 5000);
    window.addEventListener('focus', refreshJobs);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshJobs);
    };
  }, [builderOpen]);

  React.useEffect(() => {
    workerInspectionMounted.current = true;
    void inspectTrainingWorker();
    return () => {
      workerInspectionMounted.current = false;
      workerInspectionRevision.current += 1;
      workerInspectionPending.current = false;
    };
  }, [inspectTrainingWorker]);

  React.useEffect(() => {
    // Reopen a settled snapshot through the canonical read-only inspection.
    // A still-pending inspection is shared, never duplicated or treated as absence.
    if (builderOpen) void inspectTrainingWorker();
  }, [builderOpen, inspectTrainingWorker]);

  const setupTrainingWorker = React.useCallback(async () => {
    if (trainingWorkerChecking || trainingWorkerError || !trainingWorker) return;
    workerInspectionPending.current = true;
    setTrainingWorkerBusy(true);
    setTrainingWorkerError(null);
    try {
      const repairOnly = Boolean(
        trainingWorker?.installed && !trainingWorker.attested && trainingWorker.python,
      );
      setTrainingWorker(
        await installLocalTrainingWorker(
          repairOnly
            ? { includeQlora: false, allowDependencyRepair: false }
            : { includeQlora: true },
        ),
      );
    } catch (error) {
      setTrainingWorkerError(
        error instanceof Error ? error.message : 'Could not set up the local training worker.',
      );
      try {
        setTrainingWorker(await getLocalTrainingWorkerStatus());
      } catch {
        // Preserve the original setup failure when the follow-up inspection is unavailable.
      }
    } finally {
      workerInspectionPending.current = false;
      setTrainingWorkerBusy(false);
    }
  }, [trainingWorker, trainingWorkerChecking, trainingWorkerError]);

  return (
    <main
      className="h-full overflow-auto bg-background text-foreground"
      data-monochrome-route="model-foundry"
      data-sakura-route="model-foundry"
      data-warm-surface="model-foundry-canvas"
    >
      <div
        className="mx-auto grid min-h-full min-w-0 max-w-[1680px] grid-cols-[minmax(0,1fr)] gap-4 p-3 lg:grid-cols-[180px_minmax(0,1fr)] xl:grid-cols-[180px_minmax(0,1fr)_220px] xl:gap-6 xl:p-[22px]"
        data-warm-surface="model-foundry-content"
      >
        <div
          aria-hidden="true"
          className="hidden [html[data-theme=warm]_&]:block"
          data-warm-decoration="model-foundry-scene"
        >
          <img
            src="/assets/themes/warm/model-foundry/model-foundry-landscape-v3-selected.webp"
            alt=""
            decoding="async"
            draggable={false}
          />
        </div>
        <nav
          aria-label="Model Foundry workflow"
          className="min-w-0 rounded-xl border border-border bg-panel p-2 lg:sticky lg:top-3 lg:h-fit"
        >
          <div className="mb-3 hidden items-center gap-2 px-2 py-2 lg:flex">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-copper/10 text-accent-copper">
              <BrainCircuit className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-secondary font-medium">Model Foundry</p>
              <p className="text-metadata text-muted-foreground">Local studio</p>
            </div>
          </div>
          <div className="flex gap-1 overflow-x-auto lg:flex-col">
            {SECTIONS.map((item) => {
              const Icon = item.icon;
              const selected = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={selected ? 'page' : undefined}
                  onClick={() => setSection(item.id)}
                  className={cn(
                    'flex min-h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-left text-secondary transition-colors',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-copper',
                    selected
                      ? 'bg-accent-copper/10 font-medium text-accent-copper'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </button>
              );
            })}
          </div>
        </nav>

        <section
          className="min-w-0 py-1"
          aria-live="polite"
          data-warm-region="model-foundry-primary"
        >
          {section === 'overview' ? (
            <Overview
              jobs={jobs}
              onCreate={() => setBuilderOpen(true)}
              onOpenSection={setSection}
              trainingWorker={trainingWorker}
              trainingWorkerChecking={trainingWorkerChecking}
              trainingWorkerError={trainingWorkerError}
              onChooseMethod={(method) => {
                setInitialMethod(method);
                setBuilderOpen(true);
              }}
            />
          ) : (
            <SectionContent section={section} jobs={jobs} onCreate={() => setBuilderOpen(true)} />
          )}
        </section>

        <aside className="min-w-0 space-y-3 lg:col-start-2 xl:col-start-auto xl:sticky xl:top-5 xl:h-fit">
          <section className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-accent-copper" />
              <h2 className="font-medium">This computer</h2>
            </div>
            <dl className="mt-4 space-y-3 text-secondary">
              <div>
                <dt className="text-metadata uppercase tracking-wider text-muted-foreground">
                  GPU
                </dt>
                <dd className="mt-0.5 truncate">{hardware.gpu ?? 'CPU / not detected'}</dd>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <dt className="text-metadata uppercase tracking-wider text-muted-foreground">
                    VRAM
                  </dt>
                  <dd className="mt-0.5">
                    {hardware.vramGb ? `${hardware.vramGb.toFixed(1)} GB` : 'Unknown'}
                  </dd>
                </div>
                <div>
                  <dt className="text-metadata uppercase tracking-wider text-muted-foreground">
                    RAM
                  </dt>
                  <dd className="mt-0.5">
                    {hardware.ramGb ? `${hardware.ramGb.toFixed(1)} GB` : 'Unknown'}
                  </dd>
                </div>
              </div>
              <div>
                <dt className="text-metadata uppercase tracking-wider text-muted-foreground">
                  Free storage
                </dt>
                <dd className="mt-0.5 flex items-center gap-1.5">
                  <HardDrive className="h-3.5 w-3.5" />
                  {hardware.freeStorageGb
                    ? `${hardware.freeStorageGb.toFixed(1)} GB`
                    : 'Measuring…'}
                </dd>
              </div>
            </dl>
          </section>

          <section className="rounded-xl border border-accent-copper/30 bg-accent-copper/5 p-4">
            <div className="flex items-center gap-2 text-accent-copper">
              <LockKeyhole className="h-4 w-4" />
              <h2 className="font-medium">Local by design</h2>
            </div>
            <p className="mt-2 text-secondary text-muted-foreground">
              Your source data stays on this computer. VibeSpace does not upload training files.
            </p>
          </section>

          <section className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-accent-copper" />
              <h2 className="font-medium">Training runtime</h2>
            </div>
            <p className="mt-2 text-secondary text-muted-foreground">
              {trainingWorkerChecking ? 'Checking the verified local training worker…' : trainingWorkerError ??
                trainingWorker?.reason ??
                (trainingWorker?.attested
                  ? `Verified local worker · ${trainingWorker.methods.length} weight-training methods`
                  : 'Local training worker status is unknown. Check before training.')}
            </p>
            <Button
              className="mt-3 w-full"
              variant="outline"
              size="sm"
              disabled={trainingWorkerChecking || trainingWorkerBusy}
              onClick={() => void inspectTrainingWorker()}
            >
              Check training runtime
            </Button>
            {!trainingWorkerChecking && !trainingWorkerError && trainingWorker && (trainingWorker.installed && trainingWorker.attested ? (
              <div className="mt-3 flex items-center gap-2 text-metadata text-success">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Source integrity verified
              </div>
            ) : (
              <Button
                className="mt-3 w-full"
                variant="outline"
                size="sm"
                disabled={trainingWorkerBusy}
                onClick={() => void setupTrainingWorker()}
              >
                {trainingWorkerBusy ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5" />
                )}
                {trainingWorkerBusy
                  ? 'Setting up…'
                  : trainingWorker?.installed && trainingWorker.python
                    ? 'Repair local worker'
                    : 'Set up local worker'}
              </Button>
            ))}
          </section>

          <section className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-accent-copper" />
                <h2 className="font-medium">Jobs</h2>
              </div>
              <span className="font-mono text-metadata text-muted-foreground">
                {activeJobs(jobs)} active
              </span>
            </div>
            {jobs.length ? (
              <div className="mt-3 space-y-2">
                {jobs.slice(0, 3).map((job) => (
                  <button
                    key={job.id}
                    type="button"
                    onClick={() => {
                      setInitialMethod(undefined);
                      setBuilderOpen(true);
                    }}
                    className="w-full rounded-lg bg-muted/60 p-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-copper"
                  >
                    <span className="block truncate text-secondary font-medium">{job.name}</span>
                    <span className="mt-0.5 block text-metadata capitalize text-muted-foreground">
                      {statusLabel(job)} · {job.progress}%
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-secondary text-muted-foreground">No local jobs yet.</p>
            )}
          </section>
        </aside>
      </div>

      <BuildYourOwnAIHub
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        trainingWorker={trainingWorker}
        trainingWorkerChecking={trainingWorkerChecking}
        trainingWorkerError={trainingWorkerError}
        onCheckTrainingWorker={() => void inspectTrainingWorker()}
        initialMethod={initialMethod}
      />
    </main>
  );
}

export default BuildYourOwnAIPage;
