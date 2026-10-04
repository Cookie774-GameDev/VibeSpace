import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { Composer } from './Composer';

vi.mock('./HarnessReadinessGate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./HarnessReadinessGate')>()),
  useHarnessRuntimeState: () => ({ kind: 'ready' as const, source: 'managed' as const }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('opens the sketch panel from the /sketch picker and closes it', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  render(
    <TooltipProvider>
      <Composer chatId={'chat-sketch-command-test' as never} />
    </TooltipProvider>,
  );
  const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '/sketch' } });
  fireEvent.keyUp(input);
  const picker = await screen.findByRole('listbox', { name: 'Slash commands' });
  const sketch = await within(picker).findByRole('option', { name: /\/sketch/i });
  fireEvent.mouseEnter(sketch);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getByRole('dialog', { name: 'Sketch panel' })).toBeTruthy();
  expect(input.value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Close sketch' }));
  expect(screen.queryByRole('dialog', { name: 'Sketch panel' })).toBeNull();
});

it.each(['/s', '/sk', '/ske'])('suggests Sketch for %s and opens Sketchbook with Enter', async (query) => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  render(
    <TooltipProvider>
      <Composer chatId={'chat-sketch-picker-test' as never} />
    </TooltipProvider>,
  );
  const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: query } });
  fireEvent.keyUp(input);
  const picker = await screen.findByRole('listbox', { name: 'Slash commands' });
  const sketch = await within(picker).findByRole('option', { name: /\/sketch/i });
  fireEvent.mouseEnter(sketch);
  await waitFor(() => expect(sketch.getAttribute('aria-selected')).toBe('true'));
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'Sketch panel' })).toBeTruthy());
  expect(input.value).toBe('');
});
