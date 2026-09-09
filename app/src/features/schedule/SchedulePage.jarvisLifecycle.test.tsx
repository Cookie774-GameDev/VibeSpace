import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OPENCODE_CLI_CONNECTION } from '@/lib/ai/adapters/catalog';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { useJarvisLearningStore } from '@/features/jarvis-memory/learningStore';
import type { WorkspaceId } from '@/types/common';
import type { EventRow } from '@/types/event';
import type { RecurrenceInstance } from './recurrence';
import {
  parseJarvisScheduleMetadata,
  serializeJarvisScheduleMetadata,
  type JarvisScheduleMetadata,
} from './jarvisSchedules';
import { SchedulePage } from './SchedulePage';

const {
  accessibleModelsState,
  createEvent,
  deleteEvent,
  getEventById,
  getChatById,
  jarvisEventsState,
  runCaoScheduledLearning,
  recoverCaoScheduledLearning,
  runWorkspaceCaoLearningChecks,
  updateEventIfUpdatedAt,
  updateEvent,
  upcomingEventsState,
} = vi.hoisted(() => ({
  accessibleModelsState: { current: null as object | null },
  createEvent: vi.fn(),
  deleteEvent: vi.fn(),
  getEventById: vi.fn(),
  getChatById: vi.fn(),
  jarvisEventsState: { rows: [] as EventRow[] },
  runCaoScheduledLearning: vi.fn(),
  recoverCaoScheduledLearning: vi.fn(),
  runWorkspaceCaoLearningChecks: vi.fn(),
  updateEventIfUpdatedAt: vi.fn(),
  updateEvent: vi.fn(),
  upcomingEventsState: { rows: [] as RecurrenceInstance[] },
}));

vi.mock('@/lib/ai/useAccessibleChatModels', () => ({
  useAccessibleChatModels: () => accessibleModelsState.current,
}));

vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
  return {
    ...actual,
    chatRepo: { ...actual.chatRepo, getById: getChatById },
    eventRepo: {
      create: createEvent,
      getById: getEventById,
      update: updateEvent,
      updateIfUpdatedAt: updateEventIfUpdatedAt,
      delete: deleteEvent,
    },
  };
});

vi.mock('@/features/tasks', () => ({
  completeTask: vi.fn(),
  useUpcomingTasks: () => [],
}));

vi.mock('@/features/jarvis-memory/caoScheduledLearningRuntime', () => ({
  createCaoScheduledLearningDexiePersistence: () => ({
    load: vi.fn(async () => null),
  }),
  subscribeCaoScheduledLearningStatus: vi.fn(() => vi.fn()),
  getCaoScheduledLearningStatus: vi.fn(() => ({ state: 'idle' })),
  runCaoScheduledLearning,
  recoverCaoScheduledLearning,
  runManualCaoLearningChecks: runWorkspaceCaoLearningChecks,
}));

vi.mock('./hooks', () => ({
  useUpcomingEvents: () => upcomingEventsState.rows,
  useJarvisScheduleEvents: () => jarvisEventsState.rows,
}));

function buildJarvisEvent(status: EventRow['status']): EventRow {
  const startAt = new Date(2026, 8, 1, 9, 0, 0, 0).getTime();
  const metadata: JarvisScheduleMetadata = {
    kind: 'jarvis_schedule',
    prompt: 'Keep the exact route and summarize the release.',
    recurrence: 'daily',
    modelSelection: {
      mode: 'single',
      providerId: OPENCODE_CLI_CONNECTION.providerId as never,
      modelId: 'openai/gpt-5.6-sol-fast',
      connectionId: OPENCODE_CLI_CONNECTION.id,
      connectionMode: OPENCODE_CLI_CONNECTION.mode,
      authSource: OPENCODE_CLI_CONNECTION.authSource,
      capabilities: OPENCODE_CLI_CONNECTION.capabilities,
    },
    agentId: 'agent_jarvis',
    createdBy: 'jarvis',
    nextRunAt: startAt,
    outputChatId: 'chat_schedule_output',
    runHistory: [
      {
        schemaVersion: 1,
        at: startAt - 86_400_000,
        runId: 'run_1',
        requestId: 'request_1',
        status: 'completed',
      },
    ],
    errorHistory: [{ at: startAt - 43_200_000, error: 'Prior bounded failure' }],
  };
  return {
    id: 'event_jarvis_lifecycle' as EventRow['id'],
    workspace_id: 'workspace_1' as WorkspaceId,
    title: 'Jarvis Scheduled — Release brief',
    description: metadata.prompt,
    start_at: startAt,
    end_at: startAt + 30 * 60 * 1000,
    all_day: false,
    timezone: 'America/Chicago',
    attendees: [],
    source: 'ai',
    source_ref: {
      context: {
        kind: 'memory',
        id: serializeJarvisScheduleMetadata(metadata),
        excerpt: metadata.prompt,
      },
    },
    recurrence_rule: 'daily',
    reminders: [],
    status,
    created_by: 'agent_jarvis',
    created_at: startAt - 1000,
    updated_at: startAt - 1000,
  } as EventRow;
}

function buildCaoEvent(status: EventRow['status'] = 'scheduled'): EventRow {
  const event = buildJarvisEvent(status);
  const metadata = parseJarvisScheduleMetadata(event)!;
  return {
    ...event,
    id: 'event_cao_inspector' as EventRow['id'],
    title: 'Jarvis Scheduled — CAO learning review',
    updated_at: 1_750_000_000_000,
    source_ref: {
      context: {
        kind: 'memory',
        id: serializeJarvisScheduleMetadata({
          ...metadata,
          prompt: 'Review durable learning changes.',
          caoSupervision: {
            schemaVersion: 1,
            mode: 'cao_supervision',
            scheduleId: 'schedule-cao',
            policyId: 'policy-strict',
            targetId: 'learning-md',
            projectId: 'project-a',
          },
          runHistory: [
            {
              schemaVersion: 1,
              at: event.start_at - 1_000,
              runId: 'run_cao_1',
              requestId: 'request_cao_1',
              status: 'completed',
              summary: 'Durable learning review completed.',
            },
            {
              schemaVersion: 1,
              at: event.start_at - 500,
              runId: 'run_cao_2',
              requestId: 'request_cao_2',
              status: 'partial',
              summary: 'One recommendation needs review.',
            },
          ],
        }),
        excerpt: 'Review durable learning changes.',
      },
    },
  } as EventRow;
}

describe('SchedulePage Jarvis lifecycle', () => {
  const savedRouteReceipt =
    'Provider: OpenCode · Connection: opencode-cli · Model: openai/gpt-5.6-sol-fast · Fast: exact route · Effort: provider default';

  beforeEach(() => {
    window.localStorage.clear();
    createEvent.mockReset().mockResolvedValue({});
    updateEvent.mockReset().mockResolvedValue({});
    deleteEvent.mockReset().mockResolvedValue(undefined);
    getEventById.mockReset();
    getChatById
      .mockReset()
      .mockResolvedValue({
        id: 'chat_current',
        workspace_id: 'workspace_1',
        project_id: 'project_1',
      });
    useUIStore.setState({ activeChatId: 'chat_current' });
    runCaoScheduledLearning.mockReset().mockResolvedValue({ status: 'completed' });
    recoverCaoScheduledLearning.mockReset().mockResolvedValue(null);
    runWorkspaceCaoLearningChecks.mockReset().mockResolvedValue({ status: 'completed' });
    updateEventIfUpdatedAt
      .mockReset()
      .mockImplementation(async (id, expectedUpdatedAt, buildPatch) => {
        const current = jarvisEventsState.rows.find((row) => String(row.id) === String(id));
        if (!current || current.updated_at !== expectedUpdatedAt) return undefined;
        const patch = buildPatch(current);
        if (!patch) return undefined;
        return { ...current, ...patch, updated_at: current.updated_at + 1 };
      });

    const route = {
      id: `${OPENCODE_CLI_CONNECTION.id}:openai/gpt-5.6-sol-fast`,
      provider: 'opencode',
      modelId: 'openai/gpt-5.6-sol-fast',
      label: 'GPT-5.6 Sol Fast',
      connection: OPENCODE_CLI_CONNECTION,
      connectionId: OPENCODE_CLI_CONNECTION.id,
      available: true,
    };
    accessibleModelsState.current = {
      groups: [
        {
          id: `connection:${OPENCODE_CLI_CONNECTION.id}`,
          provider: 'opencode',
          label: 'OpenCode',
          options: [route],
        },
      ],
      flatOptions: [route],
      hasAny: true,
      ollamaCount: 0,
      refreshModels: vi.fn(),
    };
    const event = buildJarvisEvent('scheduled');
    jarvisEventsState.rows = [event];
    upcomingEventsState.rows = [
      {
        event,
        instanceStartMs: event.start_at,
        instanceEndMs: event.end_at,
        isRecurrence: false,
      },
    ];
    getEventById.mockResolvedValue(event);
    useAuthStore.setState({
      workspaceId: 'workspace_1' as WorkspaceId,
      projectId: 'project_1' as never,
      localUserId: 'usr_local',
      chatModelSelection: { mode: 'none' },
    });
    useJarvisLearningStore.getState().clearForTests();
    useJarvisLearningStore.getState().setAccount('usr_local');
  });

  it.each(['new', 'same'])(
    'saves a one-time delayed task in the %s chat without date fields',
    async (destination) => {
      jarvisEventsState.rows = [];
      const before = Date.now();
      render(<SchedulePage />);
      fireEvent.click(screen.getByRole('button', { name: 'Jarvis Action' }));
      fireEvent.click(screen.getByRole('button', { name: 'Run in…' }));
      expect(screen.queryByLabelText('Run at')).toBeNull();
      expect(screen.queryByLabelText('End')).toBeNull();
      expect(screen.getByRole('button', { name: 'Jarvis action model' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Every…' })).toBeNull();
      fireEvent.change(screen.getByLabelText('Wait (minutes)'), { target: { value: '3' } });
      fireEvent.change(screen.getByLabelText('Run in chat'), { target: { value: destination } });
      fireEvent.change(screen.getByLabelText(/action title/i), {
        target: { value: 'Delayed review' },
      });
      fireEvent.click(screen.getByRole('button', { name: /Save Jarvis Action/i }));
      fireEvent.click(screen.getByRole('button', { name: /Save Jarvis Action/i }));
      await waitFor(() => expect(createEvent).toHaveBeenCalledOnce());
      const input = createEvent.mock.calls[0]![0];
      expect(input.start_at).toBeGreaterThanOrEqual(before + 180_000);
      expect(input.start_at).toBeLessThanOrEqual(Date.now() + 180_000);
      expect(input.recurrence_rule).toBeUndefined();
      const metadata = parseJarvisScheduleMetadata({ ...buildJarvisEvent('scheduled'), ...input });
      expect(metadata?.recurrence).toBe('once');
      expect(metadata?.nextRunAt).toBe(input.start_at);
      expect(metadata?.outputChatId).toBe(destination === 'same' ? 'chat_current' : undefined);
    },
  );

  it('rejects a delayed task targeting a chat in another workspace', async () => {
    getChatById.mockResolvedValue({ id: 'chat_current', workspace_id: 'workspace_other' });
    render(<SchedulePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Jarvis Action' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run in…' }));
    fireEvent.change(screen.getByLabelText('Run in chat'), { target: { value: 'same' } });
    fireEvent.change(screen.getByLabelText(/action title/i), {
      target: { value: 'Delayed review' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Jarvis Action/i }));
    await waitFor(() => expect(getChatById).toHaveBeenCalled());
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('creates a project-scoped CAO learning schedule from the real Schedule form', async () => {
    jarvisEventsState.rows = [];
    upcomingEventsState.rows = [];
    const view = render(<SchedulePage />);

    fireEvent.click(screen.getByRole('button', { name: 'Jarvis Action' }));
    fireEvent.click(screen.getByRole('switch', { name: 'CAO supervised learning' }));
    fireEvent.change(screen.getByLabelText(/action title/i), {
      target: { value: 'Learning review' },
    });
    fireEvent.change(screen.getByLabelText(/instruction/i), {
      target: { value: 'Review durable learning changes.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Jarvis Action/i }));

    await waitFor(() => expect(createEvent).toHaveBeenCalledOnce());
    const input = createEvent.mock.calls[0]![0];
    expect(input.id).toMatch(/^evt_/);
    expect(input.project_id).toBe('project_1');
    const persisted = parseJarvisScheduleMetadata({
      ...buildJarvisEvent('scheduled'),
      ...input,
      id: input.id,
    } as EventRow);
    expect(persisted?.caoSupervision).toEqual({
      schemaVersion: 1,
      mode: 'cao_supervision',
      scheduleId: input.id,
      policyId: 'quarter-hour-v1',
      targetId: 'learning-md',
      projectId: 'project_1',
    });

    const createdRow = {
      ...buildJarvisEvent('scheduled'),
      ...input,
      id: input.id,
      created_at: Date.now(),
      updated_at: Date.now(),
    } as EventRow;
    jarvisEventsState.rows = [createdRow];
    getEventById.mockResolvedValue(createdRow);
    view.unmount();
    render(<SchedulePage />);
    fireEvent.click(screen.getByRole('button', { name: /Jarvis Actions1/i }));
    fireEvent.click(screen.getByText('Learning review').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: 'Run check now' }));

    await waitFor(() => expect(runCaoScheduledLearning).toHaveBeenCalledOnce());
    expect(runCaoScheduledLearning).toHaveBeenCalledWith({
      scope: {
        accountId: 'usr_local',
        workspaceId: 'workspace_1',
        projectId: 'project_1',
        scheduleId: input.id,
        targetId: 'learning-md',
        scheduleAnchorAt: input.start_at,
      },
      trigger: 'manual_force',
    });
  });

  it('does not create CAO metadata after the active project authority disappears', async () => {
    jarvisEventsState.rows = [];
    upcomingEventsState.rows = [];
    render(<SchedulePage />);

    fireEvent.click(screen.getByRole('button', { name: 'Jarvis Action' }));
    fireEvent.click(screen.getByRole('switch', { name: 'CAO supervised learning' }));
    fireEvent.change(screen.getByLabelText(/action title/i), {
      target: { value: 'Learning review' },
    });
    act(() => useAuthStore.setState({ projectId: null }));
    expect((await screen.findByRole('status')).textContent).toMatch(
      /production scope is unavailable/i,
    );
    fireEvent.click(screen.getByRole('button', { name: /Save Jarvis Action/i }));

    expect(createEvent).not.toHaveBeenCalled();
  });

  it('edits, cancels, and reopens a Jarvis schedule without losing route or run state', async () => {
    const view = render(<SchedulePage />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Jarvis Scheduled — Release brief' }));
    expect((screen.getByLabelText(/action title/i) as HTMLInputElement).value).toBe(
      'Release brief',
    );
    expect(screen.getByText(/Selected:.*GPT-5\.6 Sol Fast/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Daily$/i }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    fireEvent.change(screen.getByLabelText(/action title/i), {
      target: { value: 'Updated release brief' },
    });
    fireEvent.change(screen.getByLabelText(/instruction/i), {
      target: { value: 'Updated prompt on the same exact route.' },
    });
    fireEvent.change(screen.getByLabelText('Run at'), {
      target: { value: '2026-09-02T11:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Update Jarvis Action/i }));

    await waitFor(() => expect(updateEvent).toHaveBeenCalledOnce());
    expect(createEvent).not.toHaveBeenCalled();
    const [updatedId, patch] = updateEvent.mock.calls[0]!;
    expect(updatedId).toBe('event_jarvis_lifecycle');
    expect(patch.end_at - patch.start_at).toBe(30 * 60 * 1000);
    const updatedMetadata = parseJarvisScheduleMetadata({
      ...buildJarvisEvent('scheduled'),
      ...patch,
    } as EventRow);
    expect(updatedMetadata).toMatchObject({
      prompt: 'Updated prompt on the same exact route.',
      recurrence: 'daily',
      modelSelection: {
        providerId: 'opencode',
        modelId: 'openai/gpt-5.6-sol-fast',
        connectionId: OPENCODE_CLI_CONNECTION.id,
      },
      outputChatId: 'chat_schedule_output',
      runHistory: [{ runId: 'run_1', status: 'completed' }],
      errorHistory: [{ error: 'Prior bounded failure' }],
    });

    updateEvent.mockClear();
    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel Jarvis Scheduled — Release brief' }),
    );
    await waitFor(() =>
      expect(updateEvent).toHaveBeenCalledWith('event_jarvis_lifecycle', {
        status: 'cancelled',
      }),
    );

    updateEvent.mockClear();
    const cancelled = buildJarvisEvent('cancelled');
    jarvisEventsState.rows = [cancelled];
    upcomingEventsState.rows = [
      {
        event: cancelled,
        instanceStartMs: cancelled.start_at,
        instanceEndMs: cancelled.end_at,
        isRecurrence: false,
      },
    ];
    view.rerender(<SchedulePage />);
    fireEvent.click(screen.getByRole('button', { name: /Jarvis Actions1/i }));
    const actionTitle = screen.getByText('Release brief');
    fireEvent.click(actionTitle.closest('button')!);
    fireEvent.click(
      screen.getByRole('button', { name: 'Reopen Jarvis Scheduled — Release brief' }),
    );
    await waitFor(() =>
      expect(updateEvent).toHaveBeenCalledWith('event_jarvis_lifecycle', {
        status: 'scheduled',
      }),
    );
  });

  it('shows the exact saved route receipt in the timeline and action output', () => {
    render(<SchedulePage />);

    expect(screen.getByLabelText('Saved model identity').textContent).toBe(savedRouteReceipt);

    fireEvent.click(screen.getByRole('button', { name: /View runs & output/i }));
    expect(
      screen
        .getAllByLabelText('Saved model identity')
        .some((element) => element.textContent === savedRouteReceipt),
    ).toBe(true);
  });

  it('keeps a saved exact route editable while its live catalog row is unavailable', async () => {
    accessibleModelsState.current = {
      groups: [],
      flatOptions: [],
      hasAny: false,
      ollamaCount: 0,
      refreshModels: vi.fn(),
    };
    render(<SchedulePage />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Jarvis Scheduled — Release brief' }));
    expect(
      screen
        .getAllByText(/saved route unavailable/i)
        .some((element) => element.textContent?.includes('openai/gpt-5.6-sol-fast')),
    ).toBe(true);
    fireEvent.change(screen.getByLabelText(/action title/i), {
      target: { value: 'Retained route edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Update Jarvis Action/i }));

    await waitFor(() => expect(updateEvent).toHaveBeenCalledOnce());
    const metadata = parseJarvisScheduleMetadata({
      ...buildJarvisEvent('scheduled'),
      ...updateEvent.mock.calls[0]?.[1],
    } as EventRow);
    expect(metadata?.modelSelection).toMatchObject({
      providerId: 'opencode',
      modelId: 'openai/gpt-5.6-sol-fast',
      connectionId: OPENCODE_CLI_CONNECTION.id,
      connectionMode: OPENCODE_CLI_CONNECTION.mode,
      authSource: OPENCODE_CLI_CONNECTION.authSource,
    });
  });

  it('inspects, manually runs, pauses, and confirms deletion of a CAO schedule', async () => {
    useAuthStore.setState({ projectId: 'project-a' as never });
    const event = buildCaoEvent();
    jarvisEventsState.rows = [event];
    upcomingEventsState.rows = [];
    getEventById.mockResolvedValue(event);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SchedulePage />);

    fireEvent.click(screen.getByRole('button', { name: /Jarvis Actions1/i }));
    fireEvent.click(screen.getByText('CAO learning review').closest('button')!);

    expect(screen.getByText('CAO supervision')).toBeTruthy();
    expect(screen.getByText('schedule-cao')).toBeTruthy();
    expect(screen.getByText('project-a')).toBeTruthy();
    expect(screen.getByText('learning-md')).toBeTruthy();
    expect(screen.getByText('policy-strict')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Schedule active')).toBeTruthy();
    expect(screen.getByText('Operations floor')).toBeTruthy();
    expect(await screen.findByText(/No durable learning snapshot yet/i)).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByText('Partial')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Run check now' }));
    await waitFor(() => expect(runCaoScheduledLearning).toHaveBeenCalledOnce());
    expect(runCaoScheduledLearning).toHaveBeenCalledWith({
      scope: {
        accountId: 'usr_local',
        workspaceId: 'workspace_1',
        projectId: 'project-a',
        scheduleId: 'schedule-cao',
        targetId: 'learning-md',
        scheduleAnchorAt: event.start_at,
      },
      trigger: 'manual_force',
    });
    expect(await screen.findByText('Check completed')).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: 'Pause Jarvis Scheduled — CAO learning review' }),
    );
    await waitFor(() =>
      expect(updateEvent).toHaveBeenCalledWith('event_cao_inspector', { status: 'cancelled' }),
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Delete Jarvis Scheduled — CAO learning review' }),
    );
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/delete.*CAO learning review/i));
    expect(deleteEvent).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete Jarvis Scheduled — CAO learning review' }),
    );
    await waitFor(() => expect(deleteEvent).toHaveBeenCalledWith('event_cao_inspector'));
    confirm.mockRestore();
  });

  it('runs only the clicked active CAO row when two schedules are active', async () => {
    useAuthStore.setState({ projectId: 'project-a' as never });
    const clicked = buildCaoEvent();
    const siblingMetadata = parseJarvisScheduleMetadata(clicked)!;
    const sibling = {
      ...clicked,
      id: 'event_cao_sibling' as EventRow['id'],
      title: 'Jarvis Scheduled — Sibling CAO review',
      source_ref: {
        context: {
          kind: 'memory' as const,
          id: serializeJarvisScheduleMetadata({
            ...siblingMetadata,
            caoSupervision: {
              ...siblingMetadata.caoSupervision!,
              scheduleId: 'schedule-cao-sibling',
              targetId: 'sibling-learning-md',
            },
          }),
        },
      },
    } as EventRow;
    jarvisEventsState.rows = [clicked, sibling];
    upcomingEventsState.rows = [];
    render(<SchedulePage />);

    fireEvent.click(screen.getByRole('button', { name: /Jarvis Actions2/i }));
    fireEvent.click(screen.getByText('CAO learning review').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: 'Run check now' }));

    await waitFor(() => expect(runCaoScheduledLearning).toHaveBeenCalledOnce());
    expect(runCaoScheduledLearning).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({
          scheduleId: 'schedule-cao',
          targetId: 'learning-md',
        }),
        trigger: 'manual_force',
      }),
    );
    expect(runWorkspaceCaoLearningChecks).not.toHaveBeenCalled();
  });

  it('does not manually force a CAO row from another active project', async () => {
    const event = buildCaoEvent();
    jarvisEventsState.rows = [event];
    upcomingEventsState.rows = [];
    render(<SchedulePage />);

    fireEvent.click(screen.getByRole('button', { name: /Jarvis Actions1/i }));
    fireEvent.click(screen.getByText('CAO learning review').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: 'Run check now' }));

    await waitFor(() => expect(screen.getByText('Check failed')).toBeTruthy());
    expect(updateEventIfUpdatedAt).not.toHaveBeenCalled();
    expect(runCaoScheduledLearning).not.toHaveBeenCalled();
  });

  it.each(['paused', 'deleted', 'retargeted', 'metadata-changed'] as const)(
    'fails closed when the clicked CAO row is %s after render',
    async (change) => {
      const rendered = buildCaoEvent();
      let persisted: EventRow | undefined = rendered;
      jarvisEventsState.rows = [rendered];
      upcomingEventsState.rows = [];
      updateEventIfUpdatedAt.mockImplementation(async (id, expectedUpdatedAt, buildPatch) => {
        if (
          !persisted ||
          String(persisted.id) !== String(id) ||
          persisted.updated_at !== expectedUpdatedAt
        ) {
          return undefined;
        }
        const patch = buildPatch(persisted);
        if (!patch) return undefined;
        persisted = { ...persisted, ...patch, updated_at: persisted.updated_at + 1 };
        return persisted;
      });
      render(<SchedulePage />);

      fireEvent.click(screen.getByRole('button', { name: /Jarvis Actions1/i }));
      fireEvent.click(screen.getByText('CAO learning review').closest('button')!);
      if (change === 'deleted') {
        persisted = undefined;
      } else if (change === 'paused') {
        persisted = { ...rendered, status: 'cancelled', updated_at: rendered.updated_at + 1 };
      } else if (change === 'retargeted') {
        const metadata = parseJarvisScheduleMetadata(rendered)!;
        persisted = {
          ...rendered,
          updated_at: rendered.updated_at + 1,
          source_ref: {
            context: {
              ...rendered.source_ref!.context!,
              id: serializeJarvisScheduleMetadata({
                ...metadata,
                caoSupervision: {
                  ...metadata.caoSupervision!,
                  projectId: 'project-retargeted',
                  targetId: 'learning-retargeted',
                },
              }),
            },
          },
        } as EventRow;
      } else {
        const metadata = parseJarvisScheduleMetadata(rendered)!;
        persisted = {
          ...rendered,
          source_ref: {
            context: {
              ...rendered.source_ref!.context!,
              id: serializeJarvisScheduleMetadata({
                ...metadata,
                prompt: 'A changed instruction must require a fresh click.',
              }),
            },
          },
        } as EventRow;
      }
      fireEvent.click(screen.getByRole('button', { name: 'Run check now' }));

      await waitFor(() => expect(screen.getByText('Check failed')).toBeTruthy());
      expect(runCaoScheduledLearning).not.toHaveBeenCalled();
      expect(runWorkspaceCaoLearningChecks).not.toHaveBeenCalled();
    },
  );

  it('does not run a paused CAO row', async () => {
    const paused = buildCaoEvent('cancelled');
    jarvisEventsState.rows = [paused];
    upcomingEventsState.rows = [];
    render(<SchedulePage />);

    fireEvent.click(screen.getByRole('button', { name: /Jarvis Actions1/i }));
    fireEvent.click(screen.getByText('CAO learning review').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: 'Run check now' }));

    await waitFor(() => expect(screen.getByText('Check failed')).toBeTruthy());
    expect(runCaoScheduledLearning).not.toHaveBeenCalled();
    expect(runWorkspaceCaoLearningChecks).not.toHaveBeenCalled();
  });

  it('edits only mutable CAO policy and timing fields while preserving exact identity', async () => {
    const event = buildCaoEvent();
    const currentMetadata = parseJarvisScheduleMetadata(event)!;
    if (currentMetadata.modelSelection.mode !== 'single') {
      throw new Error('Expected the CAO fixture to use one exact model route.');
    }
    const current = {
      ...event,
      source_ref: {
        context: {
          ...event.source_ref!.context!,
          id: serializeJarvisScheduleMetadata({
            ...currentMetadata,
            modelSelection: {
              ...currentMetadata.modelSelection,
              modelId: 'openai/gpt-5.6-terra',
            },
          }),
        },
      },
    } as EventRow;
    jarvisEventsState.rows = [event];
    upcomingEventsState.rows = [];
    getEventById.mockResolvedValue(event);
    updateEventIfUpdatedAt.mockImplementation(async (_id, _updatedAt, buildPatch) => ({
      ...current,
      ...buildPatch(current),
    }));
    render(<SchedulePage />);

    fireEvent.click(screen.getByRole('button', { name: /Jarvis Actions1/i }));
    fireEvent.click(screen.getByText('CAO learning review').closest('button')!);
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit Jarvis Scheduled — CAO learning review' }),
    );
    fireEvent.change(screen.getByLabelText('CAO policy'), {
      target: { value: 'policy-balanced' },
    });
    fireEvent.change(screen.getByLabelText(/instruction/i), {
      target: { value: 'Review only durable, high-confidence learning changes.' },
    });
    fireEvent.change(screen.getByLabelText('Run at'), {
      target: { value: '2026-09-03T12:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Update Jarvis Action/i }));

    await waitFor(() => expect(updateEventIfUpdatedAt).toHaveBeenCalledOnce());
    expect(updateEventIfUpdatedAt.mock.calls[0]?.slice(0, 2)).toEqual([
      'event_cao_inspector',
      event.updated_at,
    ]);
    const patch = updateEventIfUpdatedAt.mock.calls[0]?.[2](current);
    const updated = parseJarvisScheduleMetadata({
      ...current,
      ...patch,
    } as EventRow)!;
    expect(updated.prompt).toBe('Review only durable, high-confidence learning changes.');
    expect(updated.modelSelection).toMatchObject({ modelId: 'openai/gpt-5.6-terra' });
    expect(updated.caoSupervision).toEqual({
      schemaVersion: 1,
      mode: 'cao_supervision',
      scheduleId: 'schedule-cao',
      policyId: 'policy-balanced',
      targetId: 'learning-md',
      projectId: 'project-a',
    });
  });

  it('fails a stale CAO edit closed before writing', async () => {
    const event = buildCaoEvent();
    jarvisEventsState.rows = [event];
    upcomingEventsState.rows = [];
    updateEventIfUpdatedAt.mockResolvedValue(undefined);
    render(<SchedulePage />);

    fireEvent.click(screen.getByRole('button', { name: /Jarvis Actions1/i }));
    fireEvent.click(screen.getByText('CAO learning review').closest('button')!);
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit Jarvis Scheduled — CAO learning review' }),
    );
    fireEvent.change(screen.getByLabelText('CAO policy'), {
      target: { value: 'policy-balanced' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Update Jarvis Action/i }));

    await waitFor(() => expect(updateEventIfUpdatedAt).toHaveBeenCalledOnce());
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('restores a workspace-scoped CAO edit draft with its revision and policy', async () => {
    const event = buildCaoEvent();
    jarvisEventsState.rows = [event];
    upcomingEventsState.rows = [];
    getEventById.mockResolvedValue(event);
    const first = render(<SchedulePage />);

    fireEvent.click(screen.getByRole('button', { name: /Jarvis Actions1/i }));
    fireEvent.click(screen.getByText('CAO learning review').closest('button')!);
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit Jarvis Scheduled — CAO learning review' }),
    );
    fireEvent.change(screen.getByLabelText('CAO policy'), {
      target: { value: 'policy-draft' },
    });
    fireEvent.change(screen.getByLabelText(/instruction/i), {
      target: { value: 'Unfinished CAO draft instruction.' },
    });
    await waitFor(() =>
      expect(window.localStorage.getItem('vibespace-schedule-draft-v1:workspace_1')).toContain(
        'policy-draft',
      ),
    );

    first.unmount();
    render(<SchedulePage />);
    expect((screen.getByLabelText('CAO policy') as HTMLInputElement).value).toBe('policy-draft');
    expect((screen.getByLabelText(/instruction/i) as HTMLTextAreaElement).value).toBe(
      'Unfinished CAO draft instruction.',
    );
    expect(screen.getByText(`Revision ${event.updated_at}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Update Jarvis Action/i })).toBeTruthy();

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }));
    expect(screen.getByLabelText('CAO policy')).toBeTruthy();
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/discard.*CAO schedule edit/i));

    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }));
    expect(screen.queryByLabelText('CAO policy')).toBeNull();
    confirm.mockRestore();
  });
});
