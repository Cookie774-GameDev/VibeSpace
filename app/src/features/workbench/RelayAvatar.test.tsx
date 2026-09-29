import * as React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { natureAvatarForIdentity } from '@/features/avatars/natureAvatarAssignment';
import { RelayAvatar, RelayAvatarProvider } from './RelayAvatar';
import type { RelayRoomView } from './RelayGroupChat';
const participant = {
  id: 'coral-guide',
  name: 'Coral Guide',
  kind: 'agent' as const,
  status: 'online' as const,
};
const base: RelayRoomView = {
  roomId: 'one',
  connection: 'connected',
  scope: 'Project',
  participants: [participant],
  messages: [],
};
const fresh = (id: string, at = 1000): RelayRoomView => ({
  ...base,
  messages: [{ id, at, participantId: participant.id, text: id, kind: 'message' }],
});
let hidden = false;
let reduced = false;
let mediaListeners: Set<() => void>;
let observers: { target: Element; callback: IntersectionObserverCallback }[];
const frame = () => document.querySelector('[data-relay-avatar]')?.getAttribute('data-frame');
const count = () => document.querySelector('[data-relay-avatar]')?.getAttribute('data-reactions');
const avatar = <RelayAvatar participant={participant} size={48} />;

beforeEach(() => {
  // jsdom schedules a storage event on the first persisted assignment.
  natureAvatarForIdentity(participant.id);
  vi.useFakeTimers();
  hidden = false;
  reduced = false;
  mediaListeners = new Set();
  observers = [];
  // The player has its own manifest/playback tests. Keep it pending here so
  // these tests isolate Relay's delivery timeline without player idle timers.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return reduced;
    },
    addEventListener(_type: string, listener: () => void) {
      mediaListeners.add(listener);
    },
    removeEventListener(_type: string, listener: () => void) {
      mediaListeners.delete(listener);
    },
  }));
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        observers.push({ target, callback: this.callback });
        this.callback(
          [{ target, isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect() {
        observers = observers.filter((item) => item.callback !== this.callback);
      }
    },
  );
});
afterEach(() => {
  cleanup();
  expect(vi.getTimerCount()).toBe(0);
  expect(mediaListeners.size).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('uses the shared nature portrait in Relay instead of the older two-profile sprite', () => {
  const view = render(<RelayAvatarProvider room={base}>{avatar}</RelayAvatarProvider>);
  expect(document.querySelector('[data-nature-avatar="coral-guide"]')).not.toBeNull();
  expect(document.querySelector('img[src*="/relay-avatars/interactive/"]')).toBeNull();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('renders a static nature portrait outside a provider', () => {
  render(avatar);
  expect(frame()).toBe('open');
  expect(
    document.querySelector<HTMLElement>('[data-nature-avatar="coral-guide"] .nature-avatar__sheet')
      ?.style.backgroundImage,
  ).toContain('/relay-avatars/nature/');
  expect(
    document.querySelector<HTMLElement>('[data-nature-avatar="coral-guide"] .nature-avatar__sheet')
      ?.style.backgroundImage,
  ).toContain('.webp');
  expect(vi.getTimerCount()).toBe(0);
});
it('stays static for reduced motion, including new text messages', () => {
  reduced = true;
  const view = render(<RelayAvatarProvider room={base}>{avatar}</RelayAvatarProvider>);
  view.rerender(<RelayAvatarProvider room={fresh('new')}>{avatar}</RelayAvatarProvider>);
  act(() => {
    vi.advanceTimersByTime(30000);
  });
  expect(frame()).toBe('open');
  expect(count()).toBe('0');
  expect(vi.getTimerCount()).toBe(0);
});
it('pauses page-hidden animation and consumes hidden messages without replay on return', () => {
  const view = render(<RelayAvatarProvider room={base}>{avatar}</RelayAvatarProvider>);
  act(() => {
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(vi.getTimerCount()).toBe(0);
  view.rerender(<RelayAvatarProvider room={fresh('hidden')}>{avatar}</RelayAvatarProvider>);
  act(() => {
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(frame()).toBe('open');
  expect(count()).toBe('0');
  expect(vi.getTimerCount()).toBe(1);
  view.rerender(<RelayAvatarProvider room={fresh('visible', 2000)}>{avatar}</RelayAvatarProvider>);
  expect(frame()).toBe('half');
  expect(count()).toBe('1');
});
it('removes offscreen timers and starts a fresh idle interval when visible again', () => {
  render(<RelayAvatarProvider room={base}>{avatar}</RelayAvatarProvider>);
  const observer = observers.find((item) => item.target.hasAttribute('data-relay-avatar'))!;
  act(() =>
    observer.callback(
      [{ target: observer.target, isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  expect(vi.getTimerCount()).toBe(0);
  act(() => {
    vi.advanceTimersByTime(30000);
    observer.callback(
      [{ target: observer.target, isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  });
  expect(frame()).toBe('open');
  expect(vi.getTimerCount()).toBe(1);
});
it('responds immediately to the OS motion preference changing during a reaction', () => {
  const view = render(<RelayAvatarProvider room={base}>{avatar}</RelayAvatarProvider>);
  view.rerender(<RelayAvatarProvider room={fresh('new')}>{avatar}</RelayAvatarProvider>);
  expect(frame()).toBe('half');
  act(() => {
    reduced = true;
    mediaListeners.forEach((listener) => listener());
  });
  expect(frame()).toBe('open');
  expect(vi.getTimerCount()).toBe(0);
});
it('survives StrictMode setup/cleanup without duplicate reactions, observers or timers', () => {
  const wrap = (room: RelayRoomView) => (
    <React.StrictMode>
      <RelayAvatarProvider room={room}>{avatar}</RelayAvatarProvider>
    </React.StrictMode>
  );
  const view = render(wrap(base));
  expect(observers).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(1);
  view.rerender(wrap(fresh('new')));
  expect(count()).toBe('1');
  view.unmount();
  expect(observers).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});
it('resets to a static baseline when the room identity changes while connected', () => {
  const view = render(<RelayAvatarProvider room={base}>{avatar}</RelayAvatarProvider>);
  view.rerender(<RelayAvatarProvider room={fresh('new')}>{avatar}</RelayAvatarProvider>);
  expect(count()).toBe('1');
  view.rerender(
    <RelayAvatarProvider room={{ ...fresh('other-history'), roomId: 'other' }}>
      {avatar}
    </RelayAvatarProvider>,
  );
  expect(count()).toBe('0');
  expect(frame()).toBe('open');
});

it('reuses one timeline for nested views of the same explicit room', () => {
  render(
    <RelayAvatarProvider room={base}>
      {avatar}
      <RelayAvatarProvider room={base}>{avatar}</RelayAvatarProvider>
    </RelayAvatarProvider>,
  );
  expect(document.querySelectorAll('[data-relay-avatar]')).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(1);
});
