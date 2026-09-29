import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import manifest from '../../../public/relay-avatars/nature/manifest.json';
import { RelayAvatar, RelayAvatarProvider } from './RelayAvatar';
import type { RelayRoomView } from './RelayGroupChat';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('plays the shared nature portrait once for a newly delivered Relay message', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => manifest }));
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ target, isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect() {}
    },
  );

  const participant = {
    id: 'relay-nature-integration',
    name: 'Relay Test Agent',
    kind: 'agent' as const,
    status: 'online' as const,
  };
  const room: RelayRoomView = {
    roomId: 'relay-nature-test',
    connection: 'connected',
    scope: 'Project',
    participants: [participant],
    messages: [],
  };
  const portrait = <RelayAvatar participant={participant} />;
  const view = render(<RelayAvatarProvider room={room}>{portrait}</RelayAvatarProvider>);
  await waitFor(() =>
    expect(view.container.querySelector('[data-avatar-ready="true"]')).not.toBeNull(),
  );
  const nature = view.container.querySelector<HTMLElement>('[data-nature-avatar]')!;
  expect(nature.dataset.frame).toBe('0');

  vi.useFakeTimers();
  const fresh = {
    ...room,
    messages: [
      {
        id: 'delivered-once',
        participantId: participant.id,
        text: 'Ready',
        at: 1000,
        kind: 'message' as const,
      },
    ],
  };
  view.rerender(<RelayAvatarProvider room={fresh}>{portrait}</RelayAvatarProvider>);
  await act(async () => {
    vi.advanceTimersByTime(350);
  });
  expect(Number(nature.dataset.frame)).toBeGreaterThan(0);
  await act(async () => {
    vi.advanceTimersByTime(1800);
  });
  expect(nature.dataset.frame).toBe('0');
  expect(view.container.querySelector('[data-relay-avatar]')?.getAttribute('data-reactions')).toBe(
    '1',
  );

  view.rerender(
    <RelayAvatarProvider room={{ ...fresh, messages: [...fresh.messages] }}>
      {portrait}
    </RelayAvatarProvider>,
  );
  await act(async () => {
    vi.advanceTimersByTime(1100);
  });
  expect(view.container.querySelector('[data-relay-avatar]')?.getAttribute('data-reactions')).toBe(
    '1',
  );
});
