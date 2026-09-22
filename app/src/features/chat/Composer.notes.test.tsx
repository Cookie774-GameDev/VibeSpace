import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { Composer } from './Composer';
const liveQueryFixture = vi.hoisted(() => ({ emptyArray: [] as unknown[] }));
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_query: unknown, _deps: unknown, defaultValue: unknown) =>
    Array.isArray(defaultValue) && defaultValue.length === 0
      ? liveQueryFixture.emptyArray
      : defaultValue,
}));
vi.mock('./HarnessReadinessGate', async (original) => ({
  ...(await original<typeof import('./HarnessReadinessGate')>()),
  useHarnessRuntimeState: () => ({ kind: 'ready' }),
}));
vi.mock('../notes/notesRuntime', () => ({
  useNoteScope: () => ({ accountId: 'a', projectId: 'p' }),
  useNotesWorkspace: () => ({
    workspace: {},
    snapshot: {
      notes: ['A', 'B'].map((id) => ({
        accountId: 'a',
        projectId: 'p',
        id,
        title: `Fixture ${id}`,
        preview: 'fixture',
        revision: 'rev',
        createdAt: 1,
        updatedAt: 1,
        pinned: false,
        favorite: false,
        trashed: false,
      })),
      loading: false,
      error: null,
    },
  }),
  currentNoteScope: () => ({ accountId: 'a', projectId: 'p' }),
  getNotesWorkspace: vi.fn(),
  openNoteReference: vi.fn(),
}));
describe('Composer Notes references', () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('routes Up/Down and Space from the composer and attaches with Enter without sending', async () => {
    render(
      <TooltipProvider>
        <Composer chatId={'notes-keyboard-test' as never} />
      </TooltipProvider>,
    );
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/notes' } });
    input.setSelectionRange(6, 6);
    fireEvent.click(input);
    await screen.findByRole('dialog', { name: 'Attach notes' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyUp(input, { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: 'Fixture B' }).getAttribute('data-active')).toBe(
      'true',
    );
    fireEvent.keyDown(input, { key: ' ' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyUp(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'Fixture A' }).getAttribute('data-active')).toBe(
      'true',
    );
    fireEvent.keyDown(input, { key: ' ' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(
      await screen.findByRole('button', { name: 'Open attached note: Fixture A' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open attached note: Fixture B' })).toBeTruthy();
    expect(input.value).toBe('');
    expect(screen.queryByRole('dialog', { name: 'Attach notes' })).toBeNull();
  });
  it('attaches two notes without sending and preserves surrounding draft text', async () => {
    const sent = vi.fn();
    window.addEventListener('jarvis:send', sent);
    const view = render(
      <TooltipProvider>
        <Composer chatId={'notes-test' as never} />
      </TooltipProvider>,
    );
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Compare /notes keep suffix' } });
    input.setSelectionRange(14, 14);
    fireEvent.click(input);
    fireEvent.click(await screen.findByRole('option', { name: 'Fixture A' }));
    fireEvent.click(screen.getByRole('option', { name: 'Fixture B' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search notes to attach' }), {
      key: 'Enter',
    });
    expect(
      await screen.findByRole('button', { name: 'Open attached note: Fixture A' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open attached note: Fixture B' })).toBeTruthy();
    expect(input.value).toBe('Compare  keep suffix');
    expect(sent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove note reference: Fixture A' }));
    expect(screen.queryByRole('button', { name: 'Open attached note: Fixture A' })).toBeNull();
    view.unmount();
    const reopened = render(
      <TooltipProvider>
        <Composer chatId={'notes-test' as never} />
      </TooltipProvider>,
    );
    expect(
      await screen.findByRole('button', { name: 'Open attached note: Fixture B' }),
    ).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe(
      'Compare  keep suffix',
    );
    reopened.rerender(
      <TooltipProvider>
        <Composer chatId={'notes-other-chat' as never} />
      </TooltipProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Open attached note: Fixture B' })).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe(
      '',
    );
    reopened.rerender(
      <TooltipProvider>
        <Composer chatId={'notes-test' as never} />
      </TooltipProvider>,
    );
    expect(
      await screen.findByRole('button', { name: 'Open attached note: Fixture B' }),
    ).toBeTruthy();
    window.removeEventListener('jarvis:send', sent);
  });
});
