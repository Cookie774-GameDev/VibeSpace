import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

it('opens the sketch panel from /sketch without leaving the command in the message', () => {
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
  expect(screen.getByRole('dialog', { name: 'Sketch panel' })).toBeTruthy();
  expect(input.value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Close sketch' }));
  expect(screen.queryByRole('dialog', { name: 'Sketch panel' })).toBeNull();
});
