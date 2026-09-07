import { fireEvent, render, screen, cleanup, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PetMiniPanel } from './PetMiniPanel';
import { hidePetPanel, minimizePetPanel } from './petTauriBridge';
const nativeWindow = vi.hoisted(() => ({
  hide: vi.fn(async () => undefined), minimize: vi.fn(async () => undefined),
  startDragging: vi.fn(async () => undefined),
  startResizeDragging: vi.fn(async () => undefined),
}));
vi.mock('./PetChatSurface', () => ({
  PetChatSurface: () => <div data-testid="real-chat-mount" />,
}));
vi.mock('./PetTerminalSurface', () => ({
  PetTerminalSurface: () => <div data-testid="real-terminal-mount" />,
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => nativeWindow,
}));
vi.mock('./petTauriBridge', () => ({ hidePetPanel: vi.fn(async () => undefined), minimizePetPanel: vi.fn(async () => undefined) }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
it('keeps both real surface entry points accessible in the native companion chrome', () => {
  render(<PetMiniPanel open windowMode onClose={vi.fn()} />);
  expect(screen.getByText('Jarvis')).toBeTruthy();
  expect(screen.getByRole('dialog').getAttribute('data-pet-native-window')).toBe('true');
  expect(screen.getByTestId('real-chat-mount')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Terminals' }));
  expect(screen.getByTestId('real-terminal-mount')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Minimize pet panel' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Close pet panel' })).toBeTruthy();
});
it('drags from the header and delegates all eight resize directions to the native window', () => {
  render(<PetMiniPanel open windowMode onClose={vi.fn()} />);
  fireEvent.pointerDown(screen.getByText('Jarvis'), { button: 0 });
  expect(screen.getByText('Jarvis').closest('[data-tauri-drag-region]')).toBeNull();
  expect(nativeWindow.startDragging).toHaveBeenCalledTimes(1);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Chat' }), { button: 0 });
  expect(nativeWindow.startDragging).toHaveBeenCalledTimes(1);
  for (const edge of ['West', 'East', 'North', 'South', 'NorthWest', 'NorthEast', 'SouthWest', 'SouthEast']) {
    fireEvent.pointerDown(screen.getByLabelText(`Resize panel ${edge}`), { button: 0 });
    expect(nativeWindow.startResizeDragging).toHaveBeenLastCalledWith(edge);
  }
});

it('can close again after a native reopen without duplicating the host pet restoration', () => {
  vi.useFakeTimers();
  render(<PetMiniPanel open windowMode onClose={vi.fn()} />);
  act(() => { vi.advanceTimersByTime(200); });
  for (let attempt = 0; attempt < 2; attempt++) {
    fireEvent.click(screen.getByRole('button', { name: 'Close pet panel' }));
    fireEvent.click(screen.getByTestId('pet-close-confirm-btn'));
    act(() => { vi.advanceTimersByTime(200); });
    expect(nativeWindow.hide).toHaveBeenCalledTimes(attempt + 1);
    fireEvent.focus(window);
  }
  fireEvent.click(screen.getByRole('button', { name: 'Minimize pet panel' }));
  act(() => { vi.advanceTimersByTime(200); });
  expect(nativeWindow.minimize).toHaveBeenCalledTimes(1);
  expect(hidePetPanel).not.toHaveBeenCalled();
  expect(minimizePetPanel).not.toHaveBeenCalled();
});
