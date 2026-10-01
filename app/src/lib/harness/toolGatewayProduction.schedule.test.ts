import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductionToolGatewayDependencies } from './toolGatewayProduction';
import type { ToolGatewayExecutionContext } from './toolGatewayRuntime';

const actions = vi.hoisted(() => ({ run: vi.fn(), legacy: vi.fn() }));
vi.mock('@/lib/actions', () => ({
  getAllActions: () => [{ id: 'schedule.create' }],
  runAction: actions.legacy,
}));
vi.mock('@/lib/ai/runtime', () => ({ runToolGatewayAction: actions.run }));
vi.mock('@/lib/sync', () => ({ enqueueMutation: vi.fn() }));
const context: ToolGatewayExecutionContext = {
  requestId: 'schedule-test-request',
  sessionId: 'schedule-test-chat',
  messageId: 'schedule-test-message',
  mutationApproved: true,
};

beforeEach(() => {
  vi.useFakeTimers();
  // September 30, 23:50 Chicago: tomorrow at 15:00 is October 1, 20:00 UTC.
  vi.setSystemTime(new Date('2026-10-01T04:50:00Z'));
  actions.run
    .mockReset()
    .mockResolvedValue({ kind: 'settled', result: { ok: true, summary: 'Created', data: { id: 'schedule-test' } } });
  actions.legacy.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('schedule tool datetime contract', () => {
  it.each(['tomorrow at 3 PM', 'not a date', '2026-10-01T15:00:00', '2026-02-30T15:00:00-06:00'])(
    'rejects unresolved or invalid time before any action: %s',
    async (schedule) => {
      const deps = createProductionToolGatewayDependencies();
      await expect(
        deps.schedule.create({ title: 'QA', action: 'QA only', schedule }, context),
      ).rejects.toThrow(/schedule_invalid/);
      expect(actions.run).not.toHaveBeenCalled();
    },
  );

  it('preserves the explicit timezone across the Chicago midnight boundary', async () => {
    const deps = createProductionToolGatewayDependencies();
    await deps.schedule.create(
      { title: 'QA', action: 'QA only', schedule: '2026-10-01T15:00:00-05:00' },
      context,
    );
    expect(actions.run).toHaveBeenCalledWith({
      actionId: 'schedule.create',
      params: {
        title: 'QA',
        prompt: 'QA only',
        recurrence: 'once',
        startAtMs: Date.parse('2026-10-01T20:00:00Z'),
      }, context,
    });
    expect(actions.legacy).not.toHaveBeenCalled();
  });

  it('retains the supported recurrence contract', async () => {
    const deps = createProductionToolGatewayDependencies();
    await deps.schedule.create({ title: 'QA', action: 'QA only', schedule: 'DAILY' }, context);
    expect(actions.run).toHaveBeenCalledWith({ actionId: 'schedule.create',
      params: expect.objectContaining({ recurrence: 'daily', startAtMs: Date.now() + 60000 }), context });
    expect(actions.legacy).not.toHaveBeenCalled();
  });

  it('reports a queued canonical handoff as pending instead of claiming schedule completion', async () => {
    actions.run.mockResolvedValueOnce({ kind: 'handoff_pending', executorKind: 'terminal', ownerId: 'owned-terminal', result: { ok: true, summary: 'Queued' } });
    await expect(createProductionToolGatewayDependencies().schedule.create({ title: 'QA', action: 'QA only', schedule: 'DAILY' }, context))
      .rejects.toMatchObject({ code: 'command_handoff_pending', data: { status: 'handoff_pending', ownerId: 'owned-terminal' } });
    expect(actions.legacy).not.toHaveBeenCalled();
  });

  it('preserves an unavailable protected host as a failure without falling back to legacy AI execution', async () => {
    actions.run.mockRejectedValueOnce(Error('tool_action_host_unavailable'));
    await expect(createProductionToolGatewayDependencies().schedule.create({ title: 'QA', action: 'QA only', schedule: 'DAILY' }, context))
      .rejects.toThrow('tool_action_host_unavailable');
    expect(actions.legacy).not.toHaveBeenCalled();
  });
});
