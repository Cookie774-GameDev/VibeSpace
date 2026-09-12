import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatSurfaceLayout } from './ChatSurfaceLayout';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reserves the measured composer height and updates after resize, then disconnects', () => {
  let resize = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect = disconnect;
  });
  let height = 120;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ height } as DOMRect));
  const { unmount } = render(<ChatSurfaceLayout>
    <div data-testid="thread" data-tour="chat-thread">Last message</div>
    <div data-tour="chat-composer" style={{ marginBottom: 20 }} />
  </ChatSurfaceLayout>);
  const host = screen.getByTestId('thread').parentElement!;
  expect(host.style.getPropertyValue('--chat-composer-clearance')).toBe('156px');
  height = 210;
  resize();
  expect(host.style.getPropertyValue('--chat-composer-clearance')).toBe('246px');
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});
