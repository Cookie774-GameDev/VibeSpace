import { act, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DictationLevelMeter } from './DictationLevelMeter';

afterEach(() => vi.restoreAllMocks());

it('tracks real loudness, decays to silence, and resumes after the overlay is hidden', () => {
  let callback: FrameRequestCallback;
  const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((next) => {
    callback = next;
    return 1;
  });
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  let visibility: DocumentVisibilityState = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const levelRef = { current: 0 };
  const { container, unmount } = render(<DictationLevelMeter levelRef={levelRef} />);
  const bar = container.querySelectorAll('span')[7]!;
  let time = 0;
  const frame = () => act(() => callback((time += 40)));
  frame();
  expect(bar.style.height).toBe('2px');
  levelRef.current = 0.8;
  frame();
  const loud = parseFloat(bar.style.height);
  expect(loud).toBeGreaterThan(10);
  visibility = 'hidden';
  request.mockClear();
  frame();
  expect(request).toHaveBeenCalledOnce();
  visibility = 'visible';
  levelRef.current = 0;
  for (let index = 0; index < 25; index++) frame();
  expect(parseFloat(bar.style.height)).toBeLessThan(2.1);
  levelRef.current = 0.8;
  frame();
  expect(parseFloat(bar.style.height)).toBeGreaterThan(10);
  unmount();
  expect(cancel).toHaveBeenCalled();
});
