import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { natureAvatarForIdentity } from '@/features/avatars/natureAvatarAssignment';
import { RelayGroupChat, type RelayRoomView } from './RelayGroupChat';

const coral = {
  id: 'coral-guide',
  name: 'Coral Guide',
  kind: 'agent' as const,
  status: 'online' as const,
};
const tide = {
  id: 'tide-scout',
  name: 'Tide Scout',
  kind: 'agent' as const,
  status: 'online' as const,
};
const message = (id: string, participantId = coral.id, at = 2000) => ({
  id,
  participantId,
  at,
  text: id,
  kind: 'message' as const,
});
const room = (messages: RelayRoomView['messages'] = []): RelayRoomView => ({
  connection: 'connected',
  scope: 'Project',
  participants: [coral, tide],
  messages,
});
const props = { open: true, humanAuthorized: true, onClose() {}, onSend() {} };
const avatars = (id: string) => [
  ...document.querySelectorAll<HTMLElement>(`[data-relay-avatar="${id}"]`),
];
const frames = (id: string) => avatars(id).map((avatar) => avatar.dataset.frame);

beforeEach(() => {
  natureAvatarForIdentity(coral.id);
  natureAvatarForIdentity(tide.id);
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
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
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('uses the same source identity for a participant chip, message and expanded profile', () => {
  render(<RelayGroupChat {...props} room={room([message('history')])} />);
  fireEvent.click(screen.getByRole('button', { name: 'View Coral Guide profile' }));
  expect(avatars(coral.id)).toHaveLength(3);
  const portraits = avatars(coral.id).map((avatar) =>
    avatar.querySelector<HTMLElement>('[data-nature-avatar]'),
  );
  expect(portraits.every((portrait) => portrait?.dataset.natureAvatar === coral.id)).toBe(true);
  expect(new Set(portraits.map((portrait) => portrait?.dataset.profile)).size).toBe(1);
  expect(avatars(coral.id).map((avatar) => avatar.style.width)).toContain('96px');
  expect(frames(coral.id)).toEqual(['open', 'open', 'open']);
});

it('publishes one fresh author reaction and never repeats an old snapshot', () => {
  const initial = room([message('history', tide.id, 1000)]);
  const view = render(<RelayGroupChat {...props} room={initial} />);
  const next = { ...initial, messages: [...initial.messages, message('fresh')] };
  view.rerender(<RelayGroupChat {...props} room={next} />);
  expect(frames(coral.id)).toEqual(['half', 'half']);
  expect(frames(tide.id)).toEqual(['open', 'open']);
  act(() => {
    vi.advanceTimersByTime(75);
  });
  expect(frames(coral.id)).toEqual(['closed', 'closed']);
  act(() => {
    vi.advanceTimersByTime(925);
  });
  expect(frames(coral.id)).toEqual(['open', 'open']);
  expect(avatars(coral.id)[0].dataset.reactions).toBe('1');
  view.rerender(
    <RelayGroupChat {...props} room={{ ...next, messages: [...next.messages].reverse() }} />,
  );
  act(() => {
    vi.advanceTimersByTime(1100);
  });
  expect(avatars(coral.id)[0].dataset.reactions).toBe('1');
  expect(avatars(tide.id)[0].dataset.reactions).toBe('0');
});

it('does not react to history arriving on reconnect or to messages while closed', () => {
  const view = render(<RelayGroupChat {...props} room={room()} />);
  view.rerender(<RelayGroupChat {...props} room={{ ...room(), connection: 'offline' }} />);
  view.rerender(<RelayGroupChat {...props} room={room([message('missed')])} />);
  expect(avatars(coral.id)[0]?.dataset.reactions).toBe('0');
  view.rerender(<RelayGroupChat {...props} open={false} room={room([message('missed')])} />);
  view.rerender(
    <RelayGroupChat
      {...props}
      room={room([message('missed'), message('closed-history', coral.id, 3000)])}
    />,
  );
  expect(avatars(coral.id)[0]?.dataset.reactions).toBe('0');
});
