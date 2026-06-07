import { beforeEach, describe, expect, it, vi } from 'vitest';

const syncMock = vi.hoisted(() => ({
  enqueueMutation: vi.fn(async () => 'syq_test'),
}));

vi.mock('@/lib/sync', () => syncMock);

import { useToolStore } from './toolStore';

describe('custom tool cloud sync queue', () => {
  beforeEach(() => {
    syncMock.enqueueMutation.mockClear();
    useToolStore.setState({ tools: [] });
  });

  it('queues create, update, and delete mutations', async () => {
    const tool = useToolStore.getState().create({
      name: 'Dev server',
      description: 'Start dev',
      baseAction: 'terminal.run',
      params: { command: 'npm run dev' },
    });

    await vi.waitFor(() => {
      expect(syncMock.enqueueMutation).toHaveBeenCalledWith(
        'insert',
        'custom_tools',
        tool.slug,
        expect.objectContaining({ slug: tool.slug }),
      );
    });

    syncMock.enqueueMutation.mockClear();
    useToolStore.getState().update(tool.slug, { description: 'Start the app' });

    await vi.waitFor(() => {
      expect(syncMock.enqueueMutation).toHaveBeenCalledWith(
        'update',
        'custom_tools',
        tool.slug,
        expect.objectContaining({ description: 'Start the app' }),
      );
    });

    syncMock.enqueueMutation.mockClear();
    useToolStore.getState().remove(tool.slug);

    await vi.waitFor(() => {
      expect(syncMock.enqueueMutation).toHaveBeenCalledWith(
        'delete',
        'custom_tools',
        tool.slug,
        null,
      );
    });
  });

  it('queues publish as a private account sync update', async () => {
    const tool = useToolStore.getState().create({
      name: 'Tea timer',
      description: 'Make tea',
      baseAction: 'clock.timer',
      params: { durationMinutes: 3, label: 'Tea' },
    });
    await vi.waitFor(() => expect(syncMock.enqueueMutation).toHaveBeenCalled());
    syncMock.enqueueMutation.mockClear();

    const result = await useToolStore.getState().publish(tool.slug);

    expect(result.ok).toBe(true);
    await vi.waitFor(() => {
      expect(syncMock.enqueueMutation).toHaveBeenCalledWith(
        'update',
        'custom_tools',
        tool.slug,
        expect.objectContaining({ slug: tool.slug }),
      );
    });
  });
});
