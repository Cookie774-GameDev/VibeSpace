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
      className="relative overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-soft [html[data-theme=monochrome]_&]:shadow-none"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,hsl(var(--accent-cyan)/0.12),transparent_55%)]" />
      <div className="relative mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-metadata font-semibold uppercase tracking-[0.18em] text-accent-cyan">
            Local model blueprint
          </p>
          <h2 className="mt-1 font-display text-section-title text-foreground">
            See exactly how your model is built
          </h2>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/70 px-3 py-1 text-metadata text-muted-foreground">
          <LockKeyhole className="h-3.5 w-3.5 text-accent-cyan" />
          No cloud upload
        </span>
      </div>
      <div className="relative grid gap-3 md:grid-cols-4">
        {stages.map((stage, index) => {
          const Icon = stage.icon;
          return (
            <React.Fragment key={stage.label}>
              <div className="relative z-[1] rounded-xl border border-border/80 bg-background/85 p-4 backdrop-blur-sm">
                <div className="mb-5 flex items-center justify-between">
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent-cyan/10 text-accent-cyan">
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  <span className="font-mono text-metadata text-muted-foreground">
                    0{index + 1}
                  </span>
                </div>
                <h3 className="font-medium text-foreground">{stage.label}</h3>
                <p className="mt-1 text-secondary text-muted-foreground">{stage.detail}</p>
              </div>
              {index < stages.length - 1 ? (
                <ChevronRight
                  aria-hidden
                  className="absolute top-1/2 z-[2] hidden h-4 w-4 -translate-y-1/2 text-accent-cyan md:block"
                  style={{ left: `${(index + 1) * 25 - 0.7}%` }}
                />
              ) : null}
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
}: {
  jobs: readonly FoundryJob[];
  onCreate(): void;
  onOpenSection(section: SectionId): void;
}) {
  const completed = verifiedJobs(jobs);
  return (
    <div className="space-y-5" data-warm-surface="model-foundry-overview">
      <div className="max-w-2xl">
        <p className="text-metadata font-semibold uppercase tracking-[0.18em] text-accent-copper">
          Your private model workshop
        </p>
        <h1 className="mt-2 font-display text-hero text-foreground">Build Your Own AI</h1>
        <p className="mt-2 max-w-xl text-body text-muted-foreground">
          Add knowledge, prepare examples, train compatible models, and verify the result without
          sending your source files away.
        </p>
        <Button className="mt-5" variant="accent" size="lg" onClick={onCreate}>
          <Sparkles className="h-4 w-4" />
          Create a local model
        </Button>
      </div>

      <Blueprint />

      <section aria-labelledby="foundry-paths-heading">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="foundry-paths-heading" className="font-display text-section-title">
            Choose how deeply to customize
          </h2>
          <button
            type="button"
            className="text-secondary font-medium text-accent-cyan hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-cyan"
            onClick={() => onOpenSection('train')}
          >
            Compare methods
          </button>
        </div>
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
          {[
            {
              title: 'Add knowledge',
              technical: 'RAG',
              description: 'Fastest path. Search private sources without changing model weights.',
              ready: true,
              section: 'create' as const,
            },
            {
              title: 'Teach a specialty',
              technical: 'LoRA',
              description: 'Train a small adapter when a verified worker and compatible GPU fit.',
              ready: false,
              section: 'train' as const,
            },
            {
              title: 'Train efficiently',
              technical: 'QLoRA',
              description: 'Use quantized training to lower memory needs on supported hardware.',
              ready: false,
              section: 'train' as const,
            },
            {
              title: 'Train all weights',
              technical: 'Full weight',
              description: 'Available only for small models that safely fit the detected machine.',
              ready: false,
              section: 'train' as const,
            },
          ].map((method) => (
            <button
              key={method.technical}
              type="button"
              className="rounded-xl border border-border bg-card p-4 text-left transition-[border-color,transform] hover:-translate-y-0.5 hover:border-accent-cyan/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan"
              aria-label={`${method.technical}: ${method.title}`}
              onClick={() => onOpenSection(method.section)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="rounded-full bg-muted px-2 py-1 font-mono text-metadata text-muted-foreground">
                  {method.technical}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 text-metadata',
                    method.ready ? 'text-success' : 'text-muted-foreground',
                  )}
                >
                  {method.ready ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <Gauge className="h-3.5 w-3.5" />
                  )}
                  {method.ready ? 'Ready' : 'Hardware checked'}
                </span>
              </div>
              <h3 className="mt-5 font-medium text-foreground">{method.title}</h3>
              <p className="mt-1 text-secondary text-muted-foreground">{method.description}</p>
            </button>
          ))}
        </div>
      </section>

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
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-accent-cyan/10 text-accent-cyan">
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
                <Icon className="h-5 w-5 text-accent-cyan" />
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
        <FlaskConical className="h-7 w-7 text-accent-cyan" />
        <h1 className="mt-5 font-display text-hero">Evaluate before activation</h1>
        <p className="mt-2 text-body text-muted-foreground">
          Compare held-out examples, inspect failures, and verify artifact integrity before a model
          becomes available to Agents or Chat.
        </p>
        <div className="mt-6 rounded-xl border border-border bg-card p-5">
          <p className="text-secondary text-muted-foreground">
            Evaluation reports appear here after a training job reaches the verification stage.
          </p>
        </div>
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
  const [hardware, setHardware] = React.useState<HardwareProfile>(INITIAL_HARDWARE);
  const [trainingWorker, setTrainingWorker] = React.useState<LocalTrainingWorkerStatus | null>(
    null,
  );
  const [trainingWorkerBusy, setTrainingWorkerBusy] = React.useState(false);
  const [trainingWorkerError, setTrainingWorkerError] = React.useState<string | null>(null);
  const [jobs, setJobs] = React.useState<FoundryJob[]>(() =>
    typeof window === 'undefined' ? [] : loadJobs(window.localStorage),
  );

  React.useEffect(() => {
    let cancelled = false;
    void detectHardware().then((profile) => {
      if (!cancelled) setHardware(profile);
    });
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<FoundryJob[]>('model_foundry_list_jobs'))
      .then((nativeJobs) => {
        if (!cancelled && Array.isArray(nativeJobs)) setJobs(nativeJobs);
      })
      .catch(() => {
        // Web preview keeps the durable local snapshot without inventing native job state.
      });
    return () => {
      cancelled = true;
    };
  }, [builderOpen]);

  React.useEffect(() => {
    let cancelled = false;
    void getLocalTrainingWorkerStatus()
      .then((status) => {
        if (!cancelled) setTrainingWorker(status);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setTrainingWorkerError(
            error instanceof Error ? error.message : 'Could not inspect the local training worker.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setupTrainingWorker = React.useCallback(async () => {
    setTrainingWorkerBusy(true);
    setTrainingWorkerError(null);
    try {
      setTrainingWorker(await installLocalTrainingWorker());
    } catch (error) {
      setTrainingWorkerError(
        error instanceof Error ? error.message : 'Could not set up the local training worker.',
      );
    } finally {
      setTrainingWorkerBusy(false);
    }
  }, []);

  return (
    <main
      className="h-full overflow-auto bg-background text-foreground"
      data-monochrome-route="model-foundry"
      data-sakura-route="model-foundry"
      data-warm-surface="model-foundry-canvas"
    >
      <div
        className="mx-auto grid min-h-full max-w-[1680px] gap-4 p-3 lg:grid-cols-[235px_minmax(0,1fr)] xl:grid-cols-[235px_minmax(0,1fr)_280px] xl:gap-8 xl:p-[22px]"
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
          className="rounded-xl border border-border bg-panel p-2 lg:sticky lg:top-3 lg:h-fit"
        >
          <div className="mb-3 hidden items-center gap-2 px-2 py-2 lg:flex">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-cyan/10 text-accent-cyan">
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
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-cyan',
                    selected
                      ? 'bg-accent-cyan/10 font-medium text-accent-cyan'
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
            />
          ) : (
            <SectionContent section={section} jobs={jobs} onCreate={() => setBuilderOpen(true)} />
          )}
        </section>

        <aside className="space-y-3 lg:col-start-2 xl:col-start-auto xl:sticky xl:top-5 xl:h-fit">
          <section className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-accent-cyan" />
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

          <section className="rounded-xl border border-accent-cyan/30 bg-accent-cyan/5 p-4">
            <div className="flex items-center gap-2 text-accent-cyan">
              <LockKeyhole className="h-4 w-4" />
              <h2 className="font-medium">Local by design</h2>
            </div>
            <p className="mt-2 text-secondary text-muted-foreground">
              Your source data stays on this computer. VibeSpace does not upload training files.
            </p>
          </section>

          <section className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-accent-cyan" />
              <h2 className="font-medium">Training runtime</h2>
            </div>
            <p className="mt-2 text-secondary text-muted-foreground">
              {trainingWorkerError ??
                trainingWorker?.reason ??
                (trainingWorker?.attested
                  ? `Verified local worker · ${trainingWorker.methods.length} weight-training methods`
                  : 'Inspecting the verified local worker…')}
            </p>
            {trainingWorker?.installed && trainingWorker.attested ? (
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
                {trainingWorkerBusy ? 'Setting up…' : 'Set up local worker'}
              </Button>
            )}
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
                    onClick={() => setSection('models')}
                    className="w-full rounded-lg bg-muted/60 p-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-cyan"
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
      />
    </main>
  );
}

export default BuildYourOwnAIPage;
