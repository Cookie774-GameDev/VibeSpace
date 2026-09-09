import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { PetJarvisButton } from './PetJarvisButton';
import { installPetVoiceHost, PET_VOICE_REQUEST, PET_VOICE_STATE } from './petVoiceBridge';
import { useUIStore } from '@/stores/ui';

const bus = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  emit: vi.fn(),
  listen: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: (...args: unknown[]) => bus.emit(...args),
  listen: (...args: unknown[]) => bus.listen(...args),
}));
vi.mock('@/stores/ui', () => ({
  useUIStore: create<{ voiceModalOpen: boolean; setVoiceModalOpen: (open: boolean) => void }>(
    (set) => ({
      voiceModalOpen: false,
      setVoiceModalOpen: (voiceModalOpen) => set({ voiceModalOpen }),
    }),
  ),
}));
let dispose: (() => void) | undefined;
beforeEach(() => {
  bus.handlers.clear();
  bus.emit.mockImplementation(async (_target, event, payload) => {
    bus.handlers.get(event)?.({ payload });
  });
  bus.listen.mockImplementation(async (event, handler) => {
    bus.handlers.set(event, handler);
    return () => {
      if (bus.handlers.get(event) === handler) bus.handlers.delete(event);
    };
  });
  useUIStore.setState({ voiceModalOpen: false });
});
afterEach(() => {
  cleanup();
  dispose?.();
  dispose = undefined;
  vi.clearAllMocks();
  vi.useRealTimers();
});

it('routes the detached button to the main authority and mirrors main-window close', async () => {
  dispose = installPetVoiceHost();
  render(<PetJarvisButton detached />);
  await waitFor(() => expect(screen.getByRole('button').hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Start Jarvis voice' }));
  expect(bus.emit).toHaveBeenCalledWith('main', PET_VOICE_REQUEST, 'open');
  expect(useUIStore.getState().voiceModalOpen).toBe(true);
  expect(
    screen.getByRole('button', { name: 'Stop Jarvis voice' }).getAttribute('aria-pressed'),
  ).toBe('true');
  act(() => useUIStore.getState().setVoiceModalOpen(false));
  expect(screen.getByRole('button', { name: 'Start Jarvis voice' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button'));
  fireEvent.click(screen.getByRole('button', { name: 'Stop Jarvis voice' }));
  expect(useUIStore.getState().voiceModalOpen).toBe(false);
});

it('keeps repeated open requests idempotent and ignores invalid requests', async () => {
  dispose = installPetVoiceHost();
  await act(async () => {});
  const transitions: boolean[] = [];
  const off = useUIStore.subscribe((s, prev) => {
    if (s.voiceModalOpen !== prev.voiceModalOpen) transitions.push(s.voiceModalOpen);
  });
  for (const payload of ['open', 'open', 'open', 'invalid']) {
    bus.handlers.get(PET_VOICE_REQUEST)?.({ payload });
  }
  expect(transitions).toEqual([true]);
  off();
});

it('does not start a local session when the main window fails to acknowledge', async () => {
  render(<PetJarvisButton detached />);
  await waitFor(() => expect(bus.emit).toHaveBeenCalledWith('main', PET_VOICE_REQUEST, 'sync'));
  act(() => bus.handlers.get(PET_VOICE_STATE)?.({ payload: false }));
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true);
  expect(useUIStore.getState().voiceModalOpen).toBe(false);
  act(() => vi.advanceTimersByTime(4000));
  expect(
    screen.getByRole('button', { name: 'Retry Jarvis voice connection' }).hasAttribute('disabled'),
  ).toBe(false);
});

it('uses the same store for an inline panel and unregisters detached listeners', async () => {
  const view = render(<PetJarvisButton detached={false} />);
  fireEvent.click(screen.getByRole('button'));
  expect(useUIStore.getState().voiceModalOpen).toBe(true);
  expect(bus.emit).not.toHaveBeenCalled();
  view.rerender(<PetJarvisButton detached />);
  await waitFor(() => expect(bus.handlers.has(PET_VOICE_STATE)).toBe(true));
  view.unmount();
  expect(bus.handlers.has(PET_VOICE_STATE)).toBe(false);
});

it('retries a failed connection and opens voice with that same click', async () => {
  bus.listen.mockRejectedValueOnce(new Error('host unavailable'));
  render(<PetJarvisButton detached />);
  await screen.findByRole('button', { name: 'Retry Jarvis voice connection' });
  dispose = installPetVoiceHost();
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(useUIStore.getState().voiceModalOpen).toBe(true));
  expect(screen.getByRole('button', { name: 'Stop Jarvis voice' })).toBeTruthy();
});
