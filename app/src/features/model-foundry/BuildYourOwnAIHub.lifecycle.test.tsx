import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildYourOwnAIHub } from './BuildYourOwnAIHub';
import { loadJobs, saveJobs, TRAINABLE_MODELS, type FoundryJob } from './modelHub';

const { invoke, syncModels, bootstrapOllama, listOllamaModels, pickSources } = vi.hoisted(() => ({
  invoke: vi.fn(),
  syncModels: vi.fn(),
  bootstrapOllama: vi.fn(),
  listOllamaModels: vi.fn(),
  pickSources: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/lib/ai/models', () => ({ syncFoundryModelOptions: syncModels }));
vi.mock('@/lib/ai/ollamaBootstrap', () => ({
  bootstrapOllamaConnection: bootstrapOllama,
}));
vi.mock('@/lib/ai/providers/ollama', () => ({ listOllamaModels }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: pickSources }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
}

function job(status: FoundryJob['status']): FoundryJob {
  return {
    id: 'job_lifecycle',
    name: 'Lifecycle fixture',
    baseModelId: TRAINABLE_MODELS[0].id,
    method: 'knowledge',
    status,
    progress: status === 'completed' ? 100 : 35,
    artifactVerified: status === 'completed',
    ...(status === 'completed' ? { artifactPath: 'C:/synthetic/artifact.json' } : {}),
    createdAt: '2026-10-05T00:00:00Z',
    updatedAt: '2026-10-05T00:00:01Z',
  };
}

function openLibrary(
  initial: FoundryJob[],
  pendingList: Promise<FoundryJob[]>,
  showLibrary = true,
) {
  saveJobs(window.localStorage, initial);
  invoke.mockImplementation((command: string) => {
    if (command === 'model_foundry_list_jobs') return pendingList;
    if (command === 'faster_whisper_status') return Promise.resolve({ ready: false });
    if (command === 'model_foundry_detect_hardware') {
      return Promise.resolve({
        cpu: 'Synthetic CPU',
        gpu: null,
        ramGb: 16,
        vramGb: 0,
        freeStorageGb: 64,
        os: 'Synthetic OS',
        accelerators: [],
      });
    }
    if (command === 'model_foundry_cancel_job') {
      return Promise.resolve({
        ...initial[0],
        status: 'cancelled',
        updatedAt: '2026-10-05T00:00:02Z',
      });
    }
    if (command === 'model_foundry_delete_job') return Promise.resolve();
    return Promise.reject(new Error(`Unexpected fixture command: ${command}`));
  });
  const view = render(
    <BuildYourOwnAIHub
      open
      onOpenChange={vi.fn()}
      onActivateArtifact={vi.fn()}
      trainingWorker={null}
      verifiedTrainingModels={[]}
    />,
  );
  if (showLibrary) fireEvent.click(screen.getByRole('button', { name: 'View model library' }));
  return view;
}

async function beginKnowledgeJob() {
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByText('Installed and verified in Ollama');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'New local fixture' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(screen.getByRole('button', { name: 'Browse local files' }));
  await screen.findByText('notes.txt');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  const start = screen.getByRole('button', { name: 'Begin local processing' });
  expect(start).toHaveProperty('disabled', false);
  fireEvent.click(start);
}

beforeEach(() => {
  window.localStorage.clear();
  invoke.mockReset();
  syncModels.mockReset();
  bootstrapOllama.mockReset().mockResolvedValue({ ready: false });
  listOllamaModels.mockReset().mockResolvedValue([TRAINABLE_MODELS[0].id]);
  pickSources.mockReset().mockResolvedValue(['C:/synthetic/notes.txt']);
});
afterEach(() => cleanup());

describe('Foundry job mutation and refresh ordering', () => {
  it.each(['cancel', 'rename', 'retry', 'resume', 'retrain', 'duplicate'] as const)(
    'uses the native %s acknowledgement contract at equal timestamps',
    async (action) => {
      const spawnsRun = ['retry', 'resume', 'retrain'].includes(action);
      const createsId = ['retry', 'retrain', 'duplicate'].includes(action);
      const initial: FoundryJob = {
        ...job(
          action === 'cancel'
            ? 'training'
            : action === 'retry'
              ? 'cancelled'
              : action === 'resume'
                ? 'failed'
                : 'completed',
        ),
        method: action === 'resume' ? 'lora' : 'knowledge',
        resumeAvailable: action === 'resume',
        updatedAt: '1791158401000',
      };
      const list = deferred<FoundryJob[]>();
      const acknowledgement = deferred<FoundryJob>();
      openLibrary([initial], list.promise);
      const prior = invoke.getMockImplementation()!;
      const command =
        action === 'rename' || action === 'retrain' || action === 'duplicate'
          ? `model_foundry_${action}_artifact`
          : `model_foundry_${action}_job`;
      invoke.mockImplementation((name: string) =>
        name === command ? acknowledgement.promise : prior(name),
      );
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('model_foundry_list_jobs'), {
        timeout: 5_000,
      });
      const label = {
        cancel: /^Cancel$/,
        rename: /^Rename$/,
        retry: /^Retry$/,
        resume: 'Resume from checkpoint',
        retrain: 'Retrain as v2',
        duplicate: /^Duplicate$/,
      }[action];
      fireEvent.click(screen.getByRole('button', { name: label }));
      if (action === 'rename') {
        fireEvent.change(screen.getByLabelText('New name for Lifecycle fixture'), {
          target: { value: 'Acknowledged name' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
      }
      await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === command)).toBe(true));
      const observed: FoundryJob = {
        ...initial,
        id: createsId ? 'job_created' : initial.id,
        name: action === 'duplicate' ? 'Observed duplicate' : initial.name,
        status: spawnsRun ? 'training' : initial.status,
        progress: 60,
        updatedAt: '1791158402000',
      };
      const acknowledged: FoundryJob = {
        ...observed,
        name:
          action === 'rename'
            ? 'Acknowledged name'
            : action === 'duplicate'
              ? 'Original duplicate snapshot'
              : observed.name,
        status: action === 'cancel' ? 'cancelled' : spawnsRun ? 'queued' : 'completed',
        progress: spawnsRun ? 5 : observed.progress,
        ...(action === 'cancel' ? { error: 'Cancellation requested by the user.' } : {}),
      };
      const remaining = createsId ? [initial] : [];
      await act(async () => {
        list.resolve([observed, ...remaining]);
        await list.promise;
      });
      expect(loadJobs(window.localStorage)[0]).toEqual(observed);
      await act(async () => {
        acknowledgement.resolve(acknowledged);
        await acknowledgement.promise;
      });
      const expected = spawnsRun || createsId ? observed : acknowledged;
      expect(loadJobs(window.localStorage)).toEqual([expected, ...remaining]);
      if (action === 'cancel')
        expect(screen.queryByRole('button', { name: /^Cancel$/ })).toBeNull();
      if (action === 'rename') expect(screen.getByText('Acknowledged name')).toBeTruthy();
    },
  );

  it('retains a strictly later native cancellation observation over an older acknowledgement', async () => {
    const initial = { ...job('training'), updatedAt: '1791158401000' };
    const list = deferred<FoundryJob[]>();
    const acknowledgement = deferred<FoundryJob>();
    openLibrary([initial], list.promise);
    const prior = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string) =>
      command === 'model_foundry_cancel_job' ? acknowledgement.promise : prior(command),
    );
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('model_foundry_list_jobs'), {
      timeout: 5_000,
    });
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('model_foundry_cancel_job', { jobId: initial.id }),
    );
    const latest: FoundryJob = {
      ...initial,
      status: 'cancelled',
      error: 'Native worker cleanup finished.',
      updatedAt: '1791158403000',
    };
    await act(async () => {
      list.resolve([latest]);
      await list.promise;
    });
    await act(async () => {
      acknowledgement.resolve({
        ...latest,
        error: 'Cancellation requested.',
        updatedAt: '1791158402000',
      });
      await acknowledgement.promise;
    });
    expect(loadJobs(window.localStorage)).toEqual([latest]);
    expect(screen.getByText('Native worker cleanup finished.')).toBeTruthy();
  });

  it.each<{
    label: string;
    observed: Partial<FoundryJob>;
    acknowledgedAt: string;
    keepObserved: boolean;
  }>([
    {
      label: 'unchanged failure permits a same-ms queued reset',
      observed: {},
      acknowledgedAt: '1791158401000',
      keepObserved: false,
    },
    {
      label: 'same-status fresh error at the acknowledgement millisecond',
      observed: { error: 'New resumed worker failure', progress: 5, updatedAt: '1791158402000' },
      acknowledgedAt: '1791158402000',
      keepObserved: true,
    },
    {
      label: 'same-status content change within one millisecond',
      observed: { error: 'Different failure in the same millisecond', progress: 5 },
      acknowledgedAt: '1791158401000',
      keepObserved: true,
    },
    {
      label: 'progressed native state at the acknowledgement millisecond',
      observed: { status: 'training', progress: 60, error: undefined, updatedAt: '1791158402000' },
      acknowledgedAt: '1791158402000',
      keepObserved: true,
    },
    {
      label: 'completed native state after an old acknowledgement',
      observed: {
        status: 'completed',
        progress: 100,
        artifactVerified: true,
        artifactPath: 'C:/synthetic/new-artifact',
        error: undefined,
        updatedAt: '1791158403000',
      },
      acknowledgedAt: '1791158402000',
      keepObserved: true,
    },
    {
      label: 'a newer acknowledgement supersedes an older changed observation',
      observed: { error: 'Earlier native failure', updatedAt: '1791158402000' },
      acknowledgedAt: '1791158403000',
      keepObserved: false,
    },
    {
      label: 'metadata changes count as observations without ordering statuses',
      observed: { name: 'Native renamed job', updatedAt: '1791158402000' },
      acknowledgedAt: '1791158402000',
      keepObserved: true,
    },
    {
      label: 'unorderable timestamps preserve a changed observation',
      observed: { error: 'Native failure with unavailable clock', updatedAt: 'unavailable' },
      acknowledgedAt: 'unavailable',
      keepObserved: true,
    },
  ])(
    'reconciles complete job snapshots: $label',
    async ({ observed, acknowledgedAt, keepObserved }) => {
      const initial: FoundryJob = {
        ...job('failed'),
        method: 'lora',
        resumeAvailable: true,
        error: 'Previous interruption',
        updatedAt: '1791158401000',
      };
      const list = deferred<FoundryJob[]>();
      const acknowledgement = deferred<FoundryJob>();
      openLibrary([initial], list.promise);
      const prior = invoke.getMockImplementation()!;
      invoke.mockImplementation((command: string) =>
        command === 'model_foundry_resume_job' ? acknowledgement.promise : prior(command),
      );
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('model_foundry_list_jobs'), {
        timeout: 5_000,
      });
      fireEvent.click(screen.getByRole('button', { name: 'Resume from checkpoint' }));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('model_foundry_resume_job', { jobId: initial.id }),
      );
      const current: FoundryJob = { ...initial, ...observed };
      await act(async () => {
        list.resolve([current]);
        await list.promise;
      });
      expect(loadJobs(window.localStorage)).toEqual([current]);
      const queued: FoundryJob = {
        ...initial,
        status: 'queued',
        progress: 5,
        resumeAvailable: false,
        error: undefined,
        updatedAt: acknowledgedAt,
      };
      await act(async () => {
        acknowledgement.resolve(queued);
        await acknowledgement.promise;
      });
      const expected = keepObserved ? current : queued;
      expect(loadJobs(window.localStorage)).toEqual([expected]);
      if (expected.error) expect(screen.getByText(expected.error)).toBeTruthy();
    },
  );

  it.each([
    ['start', '1791158402000', '1791158404000'],
    ['retry', '1791158402000', '1791158404000'],
    ['resume', '1791158402000', '1791158404000'],
    ['retry', '2026-10-05T00:00:02Z', '2026-10-05T00:00:04Z'],
    ['start', '1791158402000', '1791158402000'],
    ['resume', '1791158402000', '1791158402000'],
  ] as const)(
    'preserves same-job polling when %s acknowledges %s after polling %s',
    async (action, acknowledgedAt, polledAt) => {
      const initial: FoundryJob = {
        ...job(action === 'resume' ? 'failed' : 'cancelled'),
        method: action === 'resume' ? 'lora' : 'knowledge',
        resumeAvailable: action === 'resume',
        createdAt: '1791158400000',
        updatedAt: '1791158401000',
      };
      const list = deferred<FoundryJob[]>();
      const acknowledgement = deferred<FoundryJob>();
      bootstrapOllama.mockResolvedValue({ ready: true });
      openLibrary(action === 'start' ? [] : [initial], list.promise, action !== 'start');
      const prior = invoke.getMockImplementation()!;
      const command =
        action === 'start' ? 'model_foundry_start_training' : `model_foundry_${action}_job`;
      invoke.mockImplementation((name: string) =>
        name === command ? acknowledgement.promise : prior(name),
      );
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('model_foundry_list_jobs'), {
        timeout: 5_000,
      });
      if (action === 'start') await beginKnowledgeJob();
      else
        fireEvent.click(
          screen.getByRole('button', {
            name: action === 'retry' ? /^Retry$/ : 'Resume from checkpoint',
          }),
        );
      await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === command)).toBe(true));

      const completed: FoundryJob = {
        ...job('completed'),
        id: action === 'resume' ? initial.id : 'job_new_run',
        name: 'Completed new run',
        method: initial.method,
        updatedAt: polledAt,
      };
      const otherJobs = action === 'retry' ? [initial] : [];
      await act(async () => {
        list.resolve([completed, ...otherJobs]);
        await list.promise;
      });
      expect(loadJobs(window.localStorage)[0].status).toBe('completed');
      await act(async () => {
        acknowledgement.resolve({
          ...completed,
          status: 'queued',
          progress: 5,
          artifactVerified: false,
          artifactPath: undefined,
          updatedAt: acknowledgedAt,
        });
        await acknowledgement.promise;
      });

      expect(loadJobs(window.localStorage).find((entry) => entry.id === completed.id)).toEqual(
        completed,
      );
      expect(loadJobs(window.localStorage)).toHaveLength(1 + otherJobs.length);
      expect(
        screen.getByRole('button', { name: 'Use Completed new run with this agent' }),
      ).toBeTruthy();
    },
  );

  it.each(['1791158402000', '1791158401000'])(
    'accepts a same-ID resume at %s even though its progress restarts from queued',
    async (updatedAt) => {
      const initial: FoundryJob = {
        ...job('failed'),
        method: 'lora',
        resumeAvailable: true,
        updatedAt: '1791158401000',
      };
      const list = deferred<FoundryJob[]>();
      const acknowledgement = deferred<FoundryJob>();
      openLibrary([initial], list.promise);
      const prior = invoke.getMockImplementation()!;
      invoke.mockImplementation((command: string) =>
        command === 'model_foundry_resume_job' ? acknowledgement.promise : prior(command),
      );
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('model_foundry_list_jobs'), {
        timeout: 5_000,
      });
      fireEvent.click(screen.getByRole('button', { name: 'Resume from checkpoint' }));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('model_foundry_resume_job', { jobId: initial.id }),
      );
      await act(async () => {
        list.resolve([initial]);
        await list.promise;
      });
      const queued: FoundryJob = {
        ...initial,
        status: 'queued',
        progress: 5,
        resumeAvailable: false,
        updatedAt,
      };
      await act(async () => {
        acknowledgement.resolve(queued);
        await acknowledgement.promise;
      });
      expect(loadJobs(window.localStorage)).toEqual([queued]);
      expect(screen.getByRole('button', { name: /^Cancel$/ })).toBeTruthy();
    },
  );

  it('does not invent a job after rejected start and retains the native catalog', async () => {
    const list = deferred<FoundryJob[]>();
    const acknowledgement = deferred<FoundryJob>();
    bootstrapOllama.mockResolvedValue({ ready: true });
    openLibrary([], list.promise, false);
    const prior = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string) =>
      command === 'model_foundry_start_training' ? acknowledgement.promise : prior(command),
    );
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('model_foundry_list_jobs'), {
      timeout: 5_000,
    });
    await beginKnowledgeJob();
    await waitFor(() =>
      expect(invoke.mock.calls.some(([name]) => name === 'model_foundry_start_training')).toBe(
        true,
      ),
    );
    const existing = { ...job('completed'), id: 'job_existing' };
    await act(async () => {
      list.resolve([existing]);
      await list.promise;
    });
    await act(async () => {
      acknowledgement.reject(new Error('Synthetic native start rejected.'));
      await acknowledgement.promise.catch(() => undefined);
    });
    expect(screen.getByRole('alert').textContent).toContain('Synthetic native start rejected.');
    expect(loadJobs(window.localStorage)).toEqual([existing]);
  });

  it('keeps acknowledged cancellation when an earlier native list resolves late', async () => {
    const initial = job('training');
    const list = deferred<FoundryJob[]>();
    openLibrary([initial], list.promise);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('model_foundry_list_jobs'), {
      timeout: 5_000,
    });

    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    await waitFor(() => expect(loadJobs(window.localStorage)[0].status).toBe('cancelled'));
    await act(async () => {
      list.resolve([initial]);
      await list.promise;
    });

    expect(loadJobs(window.localStorage)[0].status).toBe('cancelled');
    expect(screen.getByRole('button', { name: /^Retry$/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Cancel$/ })).toBeNull();
  });

  it('does not resurrect a deleted artifact from an earlier native list', async () => {
    const initial = job('completed');
    const list = deferred<FoundryJob[]>();
    openLibrary([initial], list.promise);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('model_foundry_list_jobs'), {
      timeout: 5_000,
    });

    fireEvent.click(screen.getByRole('button', { name: /^Delete…$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete artifact and local data' }));
    await waitFor(() => expect(loadJobs(window.localStorage)).toEqual([]));
    await act(async () => {
      list.resolve([initial]);
      await list.promise;
    });

    expect(loadJobs(window.localStorage)).toEqual([]);
    expect(
      screen.queryByRole('button', { name: 'Use Lifecycle fixture with this agent' }),
    ).toBeNull();
    expect(screen.getByText('No verified job has started.')).toBeTruthy();
    expect(syncModels).toHaveBeenLastCalledWith([]);
  });

  it('continues accepting fresh native refreshes after rejecting a stale response', async () => {
    const initial = job('training');
    const list = deferred<FoundryJob[]>();
    const interval = vi.spyOn(window, 'setInterval');
    const view = openLibrary([initial], list.promise);
    try {
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('model_foundry_list_jobs'), {
        timeout: 5_000,
      });
      fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
      await waitFor(() => expect(loadJobs(window.localStorage)[0].status).toBe('cancelled'));
      await act(async () => {
        list.resolve([initial]);
        await list.promise;
      });

      const fresh = { ...job('cancelled'), name: 'Native renamed fixture' };
      const prior = invoke.getMockImplementation()!;
      invoke.mockImplementation((command: string) =>
        command === 'model_foundry_list_jobs' ? Promise.resolve([fresh]) : prior(command),
      );
      const refresh = interval.mock.calls.find(([, delay]) => delay === 2_000)?.[0];
      expect(typeof refresh).toBe('function');
      await act(async () => {
        (refresh as () => void)();
      });
      await waitFor(() => expect(loadJobs(window.localStorage)).toEqual([fresh]));
      expect(screen.getByText('Native renamed fixture')).toBeTruthy();
    } finally {
      view.unmount();
      interval.mockRestore();
    }
  });

  it('retains authoritative refreshes when a job action is rejected', async () => {
    const initial = job('training');
    const list = deferred<FoundryJob[]>();
    openLibrary([initial], list.promise);
    const prior = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string) =>
      command === 'model_foundry_cancel_job'
        ? Promise.reject(new Error('The native job could not be cancelled.'))
        : prior(command),
    );
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('model_foundry_list_jobs'), {
      timeout: 5_000,
    });
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    await screen.findByText('The native job could not be cancelled.');
    const current = job('completed');
    await act(async () => {
      list.resolve([current]);
      await list.promise;
    });

    expect(loadJobs(window.localStorage)).toEqual([current]);
    expect(
      screen.getByRole('button', { name: 'Use Lifecycle fixture with this agent' }),
    ).toBeTruthy();
  });

  it('ignores a pending refresh after the hub closes', async () => {
    const initial = job('training');
    const list = deferred<FoundryJob[]>();
    const view = openLibrary([initial], list.promise);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('model_foundry_list_jobs'), {
      timeout: 5_000,
    });
    view.rerender(
      <BuildYourOwnAIHub
        open={false}
        onOpenChange={vi.fn()}
        trainingWorker={null}
        verifiedTrainingModels={[]}
      />,
    );
    await act(async () => {
      list.resolve([job('completed')]);
      await list.promise;
    });
    expect(loadJobs(window.localStorage)).toEqual([initial]);
  });

  it('preserves another job refreshed while cancellation is pending', async () => {
    const initial = job('training');
    const neighbor = { ...job('queued'), id: 'job_neighbor', name: 'Independent fixture' };
    const list = deferred<FoundryJob[]>();
    const cancellation = deferred<FoundryJob>();
    openLibrary([initial, neighbor], list.promise);
    const prior = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string) =>
      command === 'model_foundry_cancel_job' ? cancellation.promise : prior(command),
    );
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('model_foundry_list_jobs'), {
      timeout: 5_000,
    });
    fireEvent.click(screen.getAllByRole('button', { name: /^Cancel$/ })[0]);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('model_foundry_cancel_job', { jobId: initial.id }),
    );

    const completedNeighbor = { ...neighbor, status: 'completed' as const, progress: 100 };
    await act(async () => {
      list.resolve([initial, completedNeighbor]);
      await list.promise;
    });
    expect(loadJobs(window.localStorage).find((entry) => entry.id === neighbor.id)?.status).toBe(
      'completed',
    );
    await act(async () => {
      cancellation.resolve(job('cancelled'));
      await cancellation.promise;
    });

    expect(loadJobs(window.localStorage).find((entry) => entry.id === initial.id)?.status).toBe(
      'cancelled',
    );
    expect(loadJobs(window.localStorage).find((entry) => entry.id === neighbor.id)?.status).toBe(
      'completed',
    );
  });
});
