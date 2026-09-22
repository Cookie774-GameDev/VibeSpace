import { describe, expect, it, vi } from 'vitest';
import { executeRouterStatusCommand, readRouterStatus } from './statusCommands';

describe('executeRouterStatusCommand', () => {
  it('returns the live catalog counts without contacting a provider', async () => {
    const snapshot = readRouterStatus();
    const readStatus = vi.fn(() => snapshot);

    await expect(
      executeRouterStatusCommand({ id: 'status.show', slots: {} }, readStatus),
    ).resolves.toEqual({
      ok: true,
      code: 'opened',
      message: `Local command router ready — ${snapshot.availableCommands} available of ${snapshot.catalogCommands} cataloged; ${snapshot.gatedCommands} gated or unproven. No provider call was made.`,
    });
    expect(readStatus).toHaveBeenCalledOnce();
  });

  it('rejects malformed arguments and corrupt status snapshots', async () => {
    const readStatus = vi.fn(
      () =>
        ({
          state: 'ready',
          catalogCommands: 2,
          availableCommands: 1,
          gatedCommands: 0,
        }) as never,
    );

    await expect(
      executeRouterStatusCommand({ id: 'status.show', slots: { provider: 'openai' } }, readStatus),
    ).resolves.toEqual({
      ok: false,
      code: 'queue_failed',
      message: 'Router status command arguments are invalid.',
    });
    await expect(
      executeRouterStatusCommand({ id: 'status.show', slots: {} }, readStatus),
    ).resolves.toEqual({
      ok: false,
      code: 'queue_failed',
      message: 'Router status is unavailable.',
    });
    expect(readStatus).toHaveBeenCalledOnce();
  });

  it('fails closed when the status reader throws or the deadline is cancelled', async () => {
    await expect(
      executeRouterStatusCommand({ id: 'status.show', slots: {} }, () => {
        throw new Error('private runtime detail');
      }),
    ).resolves.toEqual({
      ok: false,
      code: 'queue_failed',
      message: 'Router status is unavailable.',
    });

    const controller = new AbortController();
    controller.abort();
    const readStatus = vi.fn(readRouterStatus);
    await expect(
      executeRouterStatusCommand({ id: 'status.show', slots: {} }, readStatus, controller.signal),
    ).resolves.toEqual({
      ok: false,
      code: 'queue_failed',
      message: 'The instant command deadline elapsed.',
    });
    expect(readStatus).not.toHaveBeenCalled();
  });
});
