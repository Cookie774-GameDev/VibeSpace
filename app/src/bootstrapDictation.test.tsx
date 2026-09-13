import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  starts: vi.fn(),
  hide: vi.fn(async () => {}),
  listeners: new Map<string, () => void>(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, fn: () => void) => {
    mocks.listeners.set(name, fn);
    return () => mocks.listeners.delete(name);
  }),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ hide: mocks.hide }) }));
vi.mock('./features/global-dictation/GlobalDictationOverlay', () => ({
  GlobalDictationOverlay: ({ runtimeEffectsEnabled }: { runtimeEffectsEnabled: boolean }) => {
    React.useEffect(() => {
      if (!runtimeEffectsEnabled) return;
      window.addEventListener('jarvis:global-dictation-toggle', mocks.starts);
      return () => window.removeEventListener('jarvis:global-dictation-toggle', mocks.starts);
    }, [runtimeEffectsEnabled]);
    return <div data-testid="dictation-module" data-enabled={String(runtimeEffectsEnabled)} />;
  },
}));
import { DictationBootstrap } from './bootstrapDictation';
afterEach(() => {
  cleanup();
  mocks.starts.mockClear();
  mocks.hide.mockClear();
  mocks.listeners.clear();
});
describe('compact dictation startup', () => {
  it('keeps timeout feedback inside the pill and retries without mounting the workspace', async () => {
    const verify = vi
      .fn()
      .mockRejectedValueOnce(Error('native query timed out'))
      .mockResolvedValueOnce(true);
    render(<DictationBootstrap verify={verify} />);
    const retry = await screen.findByRole('button', { name: 'Retry dictation startup' });
    expect(retry.style.width).toBe('120px');
    expect(retry.style.height).toBe('30px');
    expect(screen.queryByTestId('dictation-module')).toBeNull();
    expect(document.body.textContent).not.toContain('Stack trace');
    fireEvent.click(retry);
    await screen.findByTestId('dictation-module');
    expect(verify).toHaveBeenCalledTimes(2);
    expect(mocks.starts).toHaveBeenCalledOnce();
  });
  it('queues a shortcut during verification and starts exactly once after success', async () => {
    let finish!: (value: boolean) => void;
    render(
      <DictationBootstrap
        verify={() =>
          new Promise((resolve) => {
            finish = resolve;
          })
        }
      />,
    );
    act(() => {
      window.dispatchEvent(new Event('jarvis:global-dictation-toggle'));
      window.dispatchEvent(new Event('jarvis:global-dictation-toggle'));
    });
    expect(mocks.starts).not.toHaveBeenCalled();
    await act(async () => finish(true));
    expect(mocks.starts).toHaveBeenCalledOnce();
  });
  it('retries a failed check from the native shortcut event', async () => {
    const verify = vi.fn().mockRejectedValueOnce(Error('timeout')).mockResolvedValueOnce(true);
    render(<DictationBootstrap verify={verify} />);
    await screen.findByRole('button', { name: 'Retry dictation startup' });
    act(() => mocks.listeners.get('jarvis:global-dictation-toggle')!());
    await waitFor(() => expect(mocks.starts).toHaveBeenCalledOnce());
    expect(verify).toHaveBeenCalledTimes(2);
  });
  it('does not enable speech for a runtime profile that disables it', async () => {
    let finish!: (value: boolean) => void;
    render(
      <DictationBootstrap
        verify={() =>
          new Promise((resolve) => {
            finish = resolve;
          })
        }
      />,
    );
    fireEvent(window, new Event('jarvis:global-dictation-toggle'));
    await act(async () => finish(false));
    expect(screen.getByTestId('dictation-module').getAttribute('data-enabled')).toBe('false');
    expect(mocks.starts).not.toHaveBeenCalled();
  });
  it('Escape cancels a pending start without recording when verification completes', async () => {
    let finish!: (value: boolean) => void;
    render(
      <DictationBootstrap
        verify={() =>
          new Promise((resolve) => {
            finish = resolve;
          })
        }
      />,
    );
    fireEvent(window, new Event('jarvis:global-dictation-toggle'));
    fireEvent.keyDown(window, { key: 'Escape' });
    await act(async () => finish(true));
    expect(mocks.hide).toHaveBeenCalledOnce();
    expect(mocks.starts).not.toHaveBeenCalled();
  });
});
