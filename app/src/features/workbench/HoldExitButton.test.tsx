import * as React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HoldExitButton } from './HoldExitButton';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('arms from a held keyboard key, cancels early release, and still requires confirmation', () => {
  let tick: FrameRequestCallback = () => {};
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    tick = callback;
    return 1;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  vi.spyOn(performance, 'now').mockReturnValue(100);
  const exit = vi.fn();
  render(<HoldExitButton onConfirmExit={exit} />);
  const hold = screen.getByRole('button', { name: 'Hold to arm Workbench exit' });
  fireEvent.keyDown(hold, { key: ' ' });
  fireEvent.keyUp(hold, { key: ' ' });
  act(() => tick(900));
  expect(screen.queryByRole('button', { name: 'Confirm exit' })).toBeNull();
  fireEvent.keyDown(hold, { key: 'Enter' });
  act(() => tick(900));
  expect(exit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm exit' }));
  expect(exit).toHaveBeenCalledTimes(1);
});
