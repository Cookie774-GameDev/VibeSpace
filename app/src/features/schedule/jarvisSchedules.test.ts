import { describe, expect, it, vi } from 'vitest';
import type { EventRow } from '@/types/event';
import type { WorkspaceId } from '@/types/common';
import type { ChatModelSelection } from '@/lib/ai/modelSelection';
import {
  buildJarvisScheduleEventUpdate,
  buildJarvisScheduleEventInput,
  delayedJarvisRunAt,
  findScheduleConflicts,
  isJarvisScheduleEvent,
  parseJarvisScheduleMetadata,
  scheduleActionSummary,
  serializeJarvisScheduleMetadata,
  type JarvisScheduleMetadata,
} from './jarvisSchedules';
import type { ChatSupervisionBindingV1 } from './chatSupervision';

const chatSupervision: ChatSupervisionBindingV1 = {
  version: 1,
  sourceChatId: 'chat-source',
  supervisingChatId: 'chat-supervisor',
  originatingMessageId: 'message-origin',
  originatingCardMessageId: 'message-card',
  handoffPolicyVersion: 1,
  instruction: 'Review current progress and report blockers.',
  allowReplyToSource: false,
  endsAt: 1_788_200_000_000,
};

describe('Jarvis schedules', () => {
  it('calculates one-time delays from save time and rejects invalid minutes', () => {
    expect(delayedJarvisRunAt(1, 1000)).toBe(61000);
    expect(delayedJarvisRunAt(43200, 1000)).toBe(2592001000);
    for (const minutes of [0, -1, 1.5, NaN, Infinity, 43201]) {
      expect(delayedJarvisRunAt(minutes, 1000)).toBeUndefined();
    }
  });
  it('builds a real event row input with Jarvis schedule metadata', () => {
    const input = buildJarvisScheduleEventInput({
      workspaceId: 'workspace_1' as WorkspaceId,
      createdBy: 'agent_jarvis',
      title: 'AI news',
      prompt: 'Summarize AI news',
      startAt: Date.UTC(2026, 5, 25, 13, 0),
      recurrence: 'daily',
      timezone: 'America/Chicago',
      modelSelection: { mode: 'single', providerId: 'openai', modelId: 'gpt-4o' },
      agentId: 'agent_jarvis',
    });

    expect(input.title).toBe('Jarvis Scheduled — AI news');
    expect(input.source).toBe('ai');
    expect(input.recurrence_rule).toBe('daily');
    expect(input.source_ref?.context?.kind).toBe('memory');
    expect(JSON.stringify(input.source_ref)).toContain('gpt-4o');
    expect(input.end_at - input.start_at).toBe(30 * 60 * 1000);
    expect(input.all_day).toBe(false);
    expect(input.reminders).toEqual([]);
  });

  it('round-trips only a complete versioned CAO supervision discriminator', () => {
    const input = buildJarvisScheduleEventInput({
      workspaceId: 'workspace_1' as WorkspaceId,
      projectId: 'project_1',
      createdBy: 'agent_jarvis',
      title: 'CAO supervision',
      prompt: 'Review the bounded learning journal.',
      startAt: 1_000,
      recurrence: 'custom_interval',
      intervalMs: 15 * 60 * 1000,
      timezone: 'UTC',
      modelSelection: { mode: 'single', providerId: 'openai', modelId: 'gpt-test' },
      agentId: 'agent_jarvis',
      caoSupervision: {
        schemaVersion: 1,
        mode: 'cao_supervision',
        scheduleId: 'cao-schedule-1',
        policyId: 'quarter-hour-v1',
        targetId: 'learning-md',
        projectId: 'project_1',
      },
    });
    const parsed = parseJarvisScheduleMetadata({ source_ref: input.source_ref } as EventRow);
    expect(parsed?.caoSupervision).toEqual({
      schemaVersion: 1,
      mode: 'cao_supervision',
      scheduleId: 'cao-schedule-1',
      policyId: 'quarter-hour-v1',
      targetId: 'learning-md',
      projectId: 'project_1',
    });
  });

  it('round-trips a valid chat supervision binding through the existing metadata prefix', () => {
    const input = buildJarvisScheduleEventInput({
      workspaceId: 'workspace_1' as WorkspaceId,
      projectId: 'project_1',
      createdBy: 'usr_local',
      title: 'Chat supervision',
      prompt: chatSupervision.instruction,
      startAt: 1_788_000_000_000,
      recurrence: 'custom_interval',
      intervalMs: 30 * 60 * 1000,
      timezone: 'UTC',
      modelSelection: { mode: 'single', providerId: 'openai', modelId: 'gpt-test' },
      agentId: 'agent_jarvis',
      chatSupervision,
    });

    expect(parseJarvisScheduleMetadata({ source_ref: input.source_ref } as EventRow)).toMatchObject(
      {
        intervalMs: 30 * 60 * 1000,
        chatSupervision,
      },
    );
  });

  it('continues to enforce the existing minimum custom interval for supervision schedules', () => {
    const input = buildJarvisScheduleEventInput({
      workspaceId: 'workspace_1' as WorkspaceId,
      createdBy: 'usr_local',
      title: 'Too frequent supervision',
      prompt: chatSupervision.instruction,
      startAt: 1_788_000_000_000,
      recurrence: 'custom_interval',
      intervalMs: 4 * 60 * 1000,
      timezone: 'UTC',
      modelSelection: { mode: 'single', providerId: 'openai', modelId: 'gpt-test' },
      agentId: 'agent_jarvis',
      chatSupervision,
    });

    expect(
      parseJarvisScheduleMetadata({ source_ref: input.source_ref } as EventRow)?.intervalMs,
    ).toBe(undefined);
  });

  it('updates an explicitly supplied supervision binding through the existing event update path', () => {
    const created = buildJarvisScheduleEventInput({
      workspaceId: 'workspace_1' as WorkspaceId,
      createdBy: 'usr_local',
      title: 'Chat supervision',
      prompt: chatSupervision.instruction,
      startAt: 1_788_000_000_000,
      recurrence: 'daily',
      timezone: 'UTC',
      modelSelection: { mode: 'single', providerId: 'openai', modelId: 'gpt-test' },
      agentId: 'agent_jarvis',
      chatSupervision,
    });
    const event = {
      id: 'event-supervision',
      attendees: [],
      created_at: 1,
      updated_at: 1,
      ...created,
    } as EventRow;
    const updatedBinding: ChatSupervisionBindingV1 = {
      ...chatSupervision,
      instruction: 'Review progress and send visible guidance.',
      allowReplyToSource: true,
    };

    const patch = buildJarvisScheduleEventUpdate(event, {
      title: 'Updated supervision',
      prompt: updatedBinding.instruction,
      startAt: 1_788_086_400_000,
      recurrence: 'daily',
      timezone: 'UTC',
      modelSelection: { mode: 'single', providerId: 'openai', modelId: 'gpt-test' },
      chatSupervision: updatedBinding,
    });

    expect(
      parseJarvisScheduleMetadata({ ...event, ...patch } as EventRow)?.chatSupervision,
    ).toEqual(updatedBinding);
  });

  it.each([
    { ...chatSupervision, version: 2 },
    { ...chatSupervision, allowReplyToSource: 'yes' },
    { ...chatSupervision, instruction: '' },
    { ...chatSupervision, extra: true },
  ])('fails the whole schedule closed for malformed chat supervision metadata %#', (binding) => {
    const metadata: JarvisScheduleMetadata = {
      kind: 'jarvis_schedule',
      prompt: 'unsafe partial extension',
      recurrence: 'once',
      modelSelection: { mode: 'single', providerId: 'openai', modelId: 'gpt-test' },
      agentId: 'agent_jarvis',
      createdBy: 'jarvis',
      runHistory: [],
      errorHistory: [],
      chatSupervision: binding as never,
    };
    const event = {
      source_ref: { context: { id: `jarvis_schedule:${JSON.stringify(metadata)}` } },
    } as EventRow;
    expect(parseJarvisScheduleMetadata(event)).toBeNull();
  });

  it('does not change ordinary or CAO metadata serialization while adding chat supervision', () => {
    const ordinary: JarvisScheduleMetadata = {
      kind: 'jarvis_schedule',
      prompt: 'ordinary',
      recurrence: 'daily',
      modelSelection: { mode: 'single', providerId: 'openai', modelId: 'gpt-test' },
      agentId: 'agent_jarvis',
      createdBy: 'jarvis',
      runHistory: [],
      errorHistory: [],
    };
    const cao: JarvisScheduleMetadata = {
      ...ordinary,
      prompt: 'cao',
      caoSupervision: {
        schemaVersion: 1,
        mode: 'cao_supervision',
        scheduleId: 'cao-schedule-1',
        policyId: 'quarter-hour-v1',
        targetId: 'learning-md',
        projectId: 'project-1',
      },
    };

    for (const metadata of [ordinary, cao]) {
      const serialized = serializeJarvisScheduleMetadata(metadata);
      const parsed = parseJarvisScheduleMetadata({
        source_ref: { context: { id: serialized } },
      } as EventRow);
      expect(serializeJarvisScheduleMetadata(parsed!)).toBe(serialized);
    }
  });

  it.each([
    { mode: 'cao_supervision' },
    {
      schemaVersion: 2,
      mode: 'cao_supervision',
      scheduleId: 's',
      policyId: 'p',
      targetId: 't',
      projectId: 'j',
    },
    {
      schemaVersion: 1,
      mode: 'ordinary',
      scheduleId: 's',
      policyId: 'p',
      targetId: 't',
      projectId: 'j',
    },
    {
      schemaVersion: 1,
      mode: 'cao_supervision',
      scheduleId: 's',
      policyId: 'p',
      targetId: 't',
      projectId: 'j',
      extra: true,
    },
  ])('fails closed for malformed or partial CAO metadata %#', (caoSupervision) => {
    const metadata: JarvisScheduleMetadata = {
      kind: 'jarvis_schedule',
      prompt: 'unsafe partial extension',
      recurrence: 'once',
      modelSelection: { mode: 'single', providerId: 'openai', modelId: 'gpt-test' },
      agentId: 'agent_jarvis',
      createdBy: 'jarvis',
      runHistory: [],
      errorHistory: [],
      caoSupervision: caoSupervision as never,
    };
    const event = {
      source_ref: { context: { id: `jarvis_schedule:${JSON.stringify(metadata)}` } },
    } as EventRow;
    expect(parseJarvisScheduleMetadata(event)).toBeNull();
  });

  it('projects an edit without losing the exact route or accumulated run state', () => {
    const originalMetadata: JarvisScheduleMetadata = {
      kind: 'jarvis_schedule',
      prompt: 'Original prompt',
      recurrence: 'daily',
      modelSelection: {
        mode: 'single',
        providerId: 'opencode' as never,
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        connectionId: 'opencode-cli',
        connectionMode: 'external-cli',
        authSource: 'opencode-cli-authenticated',
        capabilities: {
          text: true,
          images: true,
          files: true,
          tools: true,
          modelSelection: true,
          structuredOutput: true,
          streaming: true,
          cancellation: true,
          resumeSession: true,
          systemPrompt: true,
          workingDirectory: true,
          usage: true,
          subscriptionQuota: true,
          localOnly: false,
        },
      },
      agentId: 'agent_jarvis',
      createdBy: 'jarvis',
      lastRunAt: 1_786_300_000_000,
      nextRunAt: 1_786_303_600_000,
      outputChatId: 'chat_schedule_output',
      runHistory: [
        {
          schemaVersion: 1,
          at: 1_786_300_000_000,
          runId: 'run_1',
          requestId: 'request_1',
          status: 'completed',
        },
      ],
      errorHistory: [{ at: 1_786_301_000_000, error: 'Prior bounded failure' }],
    };
    const event = {
      id: 'evt_ai' as EventRow['id'],
      workspace_id: 'workspace_1' as EventRow['workspace_id'],
      title: 'Jarvis Scheduled — Original title',
      description: 'Original prompt',
      start_at: 1_786_303_600_000,
      end_at: 1_786_305_400_000,
      all_day: false,
      timezone: 'America/Chicago',
      attendees: [],
      source: 'ai',
      source_ref: {
        context: {
          kind: 'memory',
          id: serializeJarvisScheduleMetadata(originalMetadata),
          excerpt: 'Original prompt',
        },
      },
      recurrence_rule: 'daily',
      reminders: [],
      status: 'cancelled',
      created_by: 'agent_jarvis',
      created_at: 1_786_200_000_000,
      updated_at: 1_786_200_000_000,
    } as EventRow;

    const patch = buildJarvisScheduleEventUpdate(event, {
      title: 'Updated title',
      prompt: 'Updated prompt',
      startAt: 1_786_390_000_000,
      durationMs: 45 * 60 * 1000,
      recurrence: 'custom_interval',
      intervalMs: 2 * 60 * 60 * 1000,
      timezone: 'America/New_York',
      modelSelection: originalMetadata.modelSelection,
    });

    expect(patch).toMatchObject({
      title: 'Jarvis Scheduled — Updated title',
      description: 'Updated prompt',
      start_at: 1_786_390_000_000,
      end_at: 1_786_392_700_000,
      timezone: 'America/New_York',
      recurrence_rule: 'custom_interval',
    });
    expect(patch).not.toHaveProperty('status');
    const updated = parseJarvisScheduleMetadata({ ...event, ...patch } as EventRow);
    expect(updated).toMatchObject({
      prompt: 'Updated prompt',
      recurrence: 'custom_interval',
      intervalMs: 2 * 60 * 60 * 1000,
      modelSelection: originalMetadata.modelSelection,
      agentId: 'agent_jarvis',
      createdBy: 'jarvis',
      lastRunAt: 1_786_300_000_000,
      nextRunAt: 1_786_390_000_000,
      outputChatId: 'chat_schedule_output',
      runHistory: originalMetadata.runHistory,
      errorHistory: originalMetadata.errorHistory,
    });
  });

  it('keeps the next occurrence when editing the model of an active repeating action', () => {
    const startAt = 1_786_303_600_000;
    const nextRunAt = startAt + 5 * 60 * 1000;
    const modelSelection = {
      mode: 'single', providerId: 'openai', modelId: 'codex-auto-review',
      connectionId: 'openai-codex',
    } as ChatModelSelection;
    const input = buildJarvisScheduleEventInput({
      workspaceId: 'workspace_1' as EventRow['workspace_id'],
      createdBy: 'agent_jarvis', title: 'Repeating story', prompt: 'Tell a story',
      startAt, durationMs: 5 * 60 * 1000, recurrence: 'custom_interval',
      intervalMs: 5 * 60 * 1000, timezone: 'America/Chicago', modelSelection,
      agentId: 'agent_jarvis',
    });
    const event = { ...input, id: 'evt_story', updated_at: startAt,
      source_ref: { ...input.source_ref, context: {
        ...input.source_ref?.context,
        id: serializeJarvisScheduleMetadata({
          ...parseJarvisScheduleMetadata(input as EventRow)!, nextRunAt,
        }),
      } },
    } as EventRow;
    const changedModel = { ...modelSelection, modelId: 'gpt-6-luna' };
    const patch = buildJarvisScheduleEventUpdate(event, {
      title: 'Repeating story', prompt: 'Tell a story', startAt,
      recurrence: 'custom_interval', intervalMs: 5 * 60 * 1000,
      timezone: 'America/Chicago', modelSelection: changedModel,
    });
    const updated = parseJarvisScheduleMetadata({ ...event, ...patch } as EventRow);
    expect(updated?.nextRunAt).toBe(nextRunAt);
    expect(updated?.modelSelection).toMatchObject({ modelId: 'gpt-6-luna' });

    const staleMetadata = {
      ...parseJarvisScheduleMetadata(event)!,
      lastRunAt: nextRunAt,
      nextRunAt: startAt,
    };
    const staleEvent = {
      ...event,
      source_ref: { ...event.source_ref, context: {
        ...event.source_ref?.context,
        id: serializeJarvisScheduleMetadata(staleMetadata),
      } },
    } as EventRow;
    const recoveredPatch = buildJarvisScheduleEventUpdate(staleEvent, {
      title: 'Repeating story', prompt: 'Tell a story', startAt,
      recurrence: 'custom_interval', intervalMs: 5 * 60 * 1000,
      timezone: 'America/Chicago', modelSelection: changedModel,
    });
    expect(parseJarvisScheduleMetadata({ ...staleEvent, ...recoveredPatch } as EventRow)?.nextRunAt)
      .toBe(nextRunAt + 5 * 60 * 1000);
  });

  it('detects same-time conflicts without overwriting user events', () => {
    const existing = [
      {
        id: 'evt_1',
        title: 'User standup',
        start_at: 1000,
        end_at: 2000,
        source: 'manual',
      },
      {
        id: 'evt_2',
        title: 'Later',
        start_at: 5000,
        end_at: 6000,
        source: 'manual',
      },
    ] as EventRow[];

    expect(findScheduleConflicts(existing, 1500, 1800).map((event) => event.id)).toEqual(['evt_1']);
  });

  it('identifies Jarvis-created schedule events and formats short summaries', () => {
    const event = {
      id: 'evt_ai',
      title: 'Jarvis Scheduled — AI news',
      source: 'ai',
      source_ref: { context: { kind: 'memory', id: 'jarvis_schedule:daily:agent_jarvis' } },
      recurrence_rule: 'daily',
      status: 'scheduled',
    } as EventRow;

    expect(isJarvisScheduleEvent(event)).toBe(true);
    expect(scheduleActionSummary('created', event)).toBe('Created Jarvis Scheduled — AI news.');
  });

  it('uses repository updates for pause, resume, and delete actions', async () => {
    const eventRepo = {
      update: vi.fn().mockResolvedValue({ title: 'Jarvis Scheduled — AI news' }),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    await eventRepo.update('evt_1', { status: 'cancelled' });
    await eventRepo.update('evt_1', { status: 'scheduled' });
    await eventRepo.delete('evt_1');

    expect(eventRepo.update).toHaveBeenNthCalledWith(1, 'evt_1', { status: 'cancelled' });
    expect(eventRepo.update).toHaveBeenNthCalledWith(2, 'evt_1', { status: 'scheduled' });
    expect(eventRepo.delete).toHaveBeenCalledWith('evt_1');
  });

  it.each([
    ['success', 'Legacy success'],
    ['error', undefined],
  ] as const)(
    'normalizes and deterministically round-trips schema-0 %s history',
    (status, summary) => {
      const legacyEntry = {
        at: 1_786_300_000_123,
        status,
        ...(summary === undefined ? {} : { summary }),
      };
      const raw: JarvisScheduleMetadata = {
        kind: 'jarvis_schedule',
        prompt: 'Synthetic legacy prompt',
        recurrence: 'once',
        modelSelection: { mode: 'single', providerId: 'openai', modelId: 'gpt-test' },
        agentId: 'agent_jarvis',
        createdBy: 'jarvis',
        runHistory: [legacyEntry as never],
        errorHistory: [],
      };
      const encoded = `jarvis_schedule:${JSON.stringify(raw)}`;
      const event = { source_ref: { context: { id: encoded } } } as EventRow;

      const parsed = parseJarvisScheduleMetadata(event);
      expect(parsed?.runHistory).toEqual([{ schemaVersion: 0, ...legacyEntry }]);
      expect(parsed?.runHistory[0]).not.toHaveProperty('runId');
      expect(parsed?.runHistory[0]).not.toHaveProperty('requestId');
      expect(parsed?.runHistory[0]).not.toHaveProperty('eventId');
      expect(parsed?.runHistory[0]).not.toHaveProperty('artifactId');
      expect(parsed?.runHistory[0]).not.toHaveProperty('approvalId');
      expect(parsed?.runHistory[0]).not.toHaveProperty('executorResultRef');

      const serialized = serializeJarvisScheduleMetadata(parsed!);
      const serializedJson = JSON.parse(serialized.slice('jarvis_schedule:'.length));
      expect(serializedJson.runHistory).toEqual([legacyEntry]);
      expect(
        parseJarvisScheduleMetadata({ source_ref: { context: { id: serialized } } } as EventRow),
      ).toEqual(parsed);
    },
  );
});
