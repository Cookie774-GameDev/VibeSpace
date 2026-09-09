import { fireEvent, render, screen, cleanup, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PetMiniPanel } from './PetMiniPanel';
import { hidePetPanel, minimizePetPanel, setPetOverlayPosition, setPetPanelOpenFlag, showPetOverlay } from './petTauriBridge';
const nativeWindow = vi.hoisted(() => ({
  hide: vi.fn(async () => undefined), minimize: vi.fn(async () => undefined),
  outerPosition: vi.fn(async () => ({ x: 400, y: 250 })),
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
vi.mock('./petTauriBridge', () => ({
  hidePetPanel: vi.fn(async () => undefined), minimizePetPanel: vi.fn(async () => undefined),
  setPetOverlayPosition: vi.fn(async () => undefined), setPetPanelOpenFlag: vi.fn(),
  showPetOverlay: vi.fn(async () => ({ visible: true })),
}));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });
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

it('closes in one click and immediately restores the pet at the panel position on close and minimize', async () => {
  vi.useFakeTimers();
  render(<PetMiniPanel open windowMode onClose={vi.fn()} />);
  act(() => { vi.advanceTimersByTime(200); });
  for (let attempt = 0; attempt < 2; attempt++) {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close pet panel' })); });
    expect(screen.queryByTestId('pet-close-confirm')).toBeNull();
    expect(hidePetPanel).toHaveBeenCalledTimes(attempt + 1);
    expect(setPetOverlayPosition).toHaveBeenLastCalledWith(400, 250);
    expect(setPetPanelOpenFlag).toHaveBeenLastCalledWith(false);
    expect(showPetOverlay).toHaveBeenCalledTimes(attempt + 1);
    fireEvent.focus(window);
  }
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Minimize pet panel' })); });
  expect(hidePetPanel).toHaveBeenCalledTimes(3);
  expect(nativeWindow.minimize).not.toHaveBeenCalled();
  expect(nativeWindow.hide).not.toHaveBeenCalled();
  expect(showPetOverlay).toHaveBeenCalledTimes(3);
  expect(vi.mocked(setPetOverlayPosition).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(hidePetPanel).mock.invocationCallOrder[0]);
  expect(vi.mocked(hidePetPanel).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(showPetOverlay).mock.invocationCallOrder[0]);
  expect(minimizePetPanel).not.toHaveBeenCalled();
});

it.each(['Close', 'Minimize'])('animates native %s and restores controls if native dismissal fails', async (action) => {
  vi.useFakeTimers();
  let rejectHide!: (reason: Error) => void;
  vi.mocked(hidePetPanel).mockImplementationOnce(() => new Promise((_, reject) => { rejectHide = reject; }));
  const onClose = vi.fn();
  render(<PetMiniPanel open windowMode onClose={onClose} />);
  act(() => { vi.advanceTimersByTime(200); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: `${action} pet panel` })); });
  expect(screen.getByRole('dialog').getAttribute('data-pet-panel-lifecycle')).toBe(action === 'Close' ? 'closing' : 'minimizing');
  await act(async () => { rejectHide(new Error('Window busy')); });
  expect(screen.getByRole('dialog').getAttribute('data-pet-panel-lifecycle')).toBe('open');
  expect(onClose).not.toHaveBeenCalled();
});

it('scales all content together as the panel grows and shrinks without scaling resize handles twice', () => {
  vi.useFakeTimers();
  let width = 460, height = 560;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => (
    { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) }
  ));
  render(<PetMiniPanel open windowMode onClose={vi.fn()} />);
  const panel = screen.getByRole('dialog');
  const content = screen.getByTestId('pet-panel-scaled-content');
  expect(content.contains(screen.getByTestId('pet-panel-header'))).toBe(true);
  expect(content.contains(screen.getByTestId('real-chat-mount'))).toBe(true);
  expect(content.contains(screen.getByLabelText('Resize panel West'))).toBe(false);
  for (const [w, h, expected] of [[460, 560, 1], [920, 1120, 1.45], [300, 300, 0.62]]) {
    width = w; height = h;
    fireEvent(window, new Event('resize'));
    act(() => { vi.advanceTimersByTime(200); });
    expect(panel.style.getPropertyValue('--pet-content-scale')).toBe(String(expected));
    expect(panel.style.getPropertyValue('--pet-ui-scale')).toBe('1');
  }
  fireEvent.click(screen.getByRole('button', { name: 'Terminals' }));
  expect(content.contains(screen.getByTestId('real-terminal-mount'))).toBe(true);
});
