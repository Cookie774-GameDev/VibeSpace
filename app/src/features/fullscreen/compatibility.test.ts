import { beforeEach, describe, expect, it } from 'vitest';
import { executeIntent } from '@/features/assistant/execute';
import { performAction } from '@/features/command-palette/actions';
import { runAction } from '@/lib/actions';
import { useFullscreenStore } from './fullscreenStore';

describe('fullscreen compatibility entrypoints', () => {
  beforeEach(() => {
    useFullscreenStore.setState({
      focusActive: false,
      activationOrder: [],
      error: null,
    });
  });

  it('keeps the command-palette fullscreen action targeting Workspace Focus Mode', () => {
    performAction('toggle-fullscreen');
    expect(useFullscreenStore.getState().focusActive).toBe(true);
  });

  it('keeps the assistant fullscreen intent targeting Workspace Focus Mode', async () => {
    await expect(executeIntent({ kind: 'set_fullscreen', on: true })).resolves.toEqual({
      ok: true,
      message: 'Entered Focus Mode.',
    });
    expect(useFullscreenStore.getState().focusActive).toBe(true);

    await expect(executeIntent({ kind: 'set_fullscreen', on: false })).resolves.toEqual({
      ok: true,
      message: 'Exited Focus Mode.',
    });
    expect(useFullscreenStore.getState().focusActive).toBe(false);
  });

  it('keeps the public chat.fullscreen action ID compatible', async () => {
    await expect(
      runAction('chat.fullscreen', {}, { source: 'user' }, { emitToast: false }),
    ).resolves.toMatchObject({
      ok: true,
      summary: 'Workspace Focus Mode: on.',
    });
    expect(useFullscreenStore.getState().focusActive).toBe(true);
  });
});
