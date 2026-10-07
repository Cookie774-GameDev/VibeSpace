import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/stores/auth';
import { harnessRuntimeManager } from '@/lib/harness/runtimeManager';
import { nativeOpenCodeRequest } from '@/lib/harness/openCodeNativeTransport';
import { Composer } from './Composer';

const fixture = vi.hoisted(() => ({ empty: [] as unknown[], backend: 'opencode' as 'opencode' | 'codex' }));
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_query: unknown, _deps: unknown, fallback: unknown) =>
    Array.isArray(fallback) && fallback.length === 0 ? fixture.empty : fallback,
}));
vi.mock('./useChatBackendAffinity', () => ({
  useChatBackendAffinity: () => ({ version: 1, backend: fixture.backend, locked: true,
    selectedAt: 1, lockedAt: 2 }),
}));
vi.mock('./HarnessReadinessGate', async original => ({
  ...(await original<typeof import('./HarnessReadinessGate')>()),
  useHarnessRuntimeState: () => ({ kind: 'ready', source: 'managed', version: 'test' }),
}));
vi.mock('./CodexReadinessGate', async original => ({
  ...(await original<typeof import('./CodexReadinessGate')>()),
  useCodexRuntimeState: () => ({ kind: 'ready', source: 'managed', version: 'test' }),
  CodexReadinessGate: () => null,
}));
vi.mock('@/features/files/projectFiles', async original => ({
  ...(await original<typeof import('@/features/files/projectFiles')>()),
  getStoredProjectRoot: () => 'C:\\synthetic-catalog-project',
}));
vi.mock('@/lib/harness/openCodeNativeTransport', async original => ({
  ...(await original<typeof import('@/lib/harness/openCodeNativeTransport')>()),
  nativeOpenCodeRequest: vi.fn(),
}));

const originalAuth = useAuthStore.getState();
const pending: Array<(response: Response) => void> = [];
let refresh: (() => void) | undefined;
const command = { name: 'fixture-review', source: 'command', description: 'Fixture native command' };
const mcp = { ...command, source: 'mcp', description: 'Fixture MCP prompt' };
const response = (rows: unknown[]) => new Response(JSON.stringify(rows));

beforeEach(() => {
  fixture.backend = 'opencode';
  pending.length = 0;
  refresh = undefined;
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(harnessRuntimeManager, 'getConnection').mockReturnValue({ generation: 'catalog-generation-a', version: 'test', source: 'managed' });
  vi.mocked(nativeOpenCodeRequest).mockReset().mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  const originalInterval = window.setInterval;
  vi.spyOn(window, 'setInterval').mockImplementation((handler, timeout, ...args) => {
    if (timeout === 30_000 && typeof handler === 'function') refresh = () => handler(...args);
    return originalInterval.call(window, handler, timeout, ...args);
  });
  useAuthStore.setState({ localUserId: 'catalog-owner', cloudSession: null,
    workspaceId: 'catalog-workspace' as never, projectId: 'catalog-project' as never,
    chatModelSelection: { mode: 'none' } });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useAuthStore.setState(originalAuth);
});

function mount(chatId: string) {
  render(<TooltipProvider><Composer chatId={chatId as never} /></TooltipProvider>);
  expect(nativeOpenCodeRequest).toHaveBeenCalledExactlyOnceWith(
    'catalog-generation-a', '/command?directory=C%3A%5Csynthetic-catalog-project',
  );
  return screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
}
async function openPicker(input: HTMLTextAreaElement) {
  fireEvent.change(input, { target: { value: '/fixture-review', selectionStart: 15 } });
  await screen.findByRole('listbox', { name: 'Slash commands' });
}

it('reconciles a removed exact source before Enter in the real Composer host', async () => {
  const input = mount('catalog-host-reconcile');
  const warning = vi.spyOn(toast, 'warning');
  const interference = vi.fn();
  for (const name of ['jarvis:send', 'jarvis:steer', 'jarvis:cancel', 'jarvis:queue']) window.addEventListener(name, interference);
  try {
    await act(async () => pending[0]!(response([command, mcp])));
    await openPicker(input);
    const originalOption = screen.getByRole('option', { name: /Fixture native command/u });
    expect(originalOption.getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    await act(async () => refresh!());
    expect(pending).toHaveLength(2);
    await act(async () => pending[1]!(response([mcp])));
    const remaining = screen.getByRole('option', { name: /Fixture MCP prompt/u });
    expect(remaining.getAttribute('aria-selected')).toBe('true');
    const activeDescendantAfterRefresh = input.getAttribute('aria-activedescendant');
    expect(screen.queryByRole('option', { name: /Fixture native command/u })).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(input.value).toBe('/fixture-review ');
    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Slash commands' })).toBeNull());
    expect(warning).not.toHaveBeenCalled();
    expect(interference).not.toHaveBeenCalled();
    expect(activeDescendantAfterRefresh).toBe(remaining.id);
  } finally {
    for (const name of ['jarvis:send', 'jarvis:steer', 'jarvis:cancel', 'jarvis:queue']) window.removeEventListener(name, interference);
  }
});

it('keeps ambiguous same-name upstream sources unexecuted through the real Composer picker', async () => {
  const input = mount('catalog-host-ambiguous');
  const warning = vi.spyOn(toast, 'warning');
  const send = vi.fn();
  window.addEventListener('jarvis:send', send);
  try {
    await act(async () => pending[0]!(response([command, mcp])));
    await openPicker(input);
    fireEvent.keyDown(input, { key: 'ArrowDown', code: 'ArrowDown' });
    const selected = screen.getByRole('option', { name: /Fixture MCP prompt/u });
    expect(selected.getAttribute('aria-selected')).toBe('true');
    const activeDescendantAfterArrow = input.getAttribute('aria-activedescendant');
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(warning).toHaveBeenCalledWith('Choose in native CLI', expect.stringContaining('multiple upstream sources'));
    expect(input.value).toBe('/fixture-review');
    expect(screen.getByRole('listbox', { name: 'Slash commands' })).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    expect(activeDescendantAfterArrow).toBe(selected.id);
  } finally { window.removeEventListener('jarvis:send', send); }
});


it('updates the real Composer active descendant between local and native Codex MCP options', async () => {
  fixture.backend = 'codex';
  const interference = vi.fn();
  for (const name of ['jarvis:send', 'jarvis:steer', 'jarvis:cancel', 'jarvis:queue']) window.addEventListener(name, interference);
  try {
    render(<TooltipProvider><Composer chatId={'catalog-host-codex-mcp' as never} /></TooltipProvider>);
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/mcp', selectionStart: 4 } });
    await screen.findByRole('listbox', { name: 'Slash commands' });
    const options = screen.getAllByRole('option', { name: /\/mcp/u });
    expect(options).toHaveLength(2);
    const initial = options.find(option => option.getAttribute('aria-selected') === 'true')!;
    expect(initial).toBeTruthy();
    await waitFor(() => expect(input.getAttribute('aria-activedescendant')).toBe(initial.id));
    fireEvent.keyDown(input, { key: 'ArrowDown', code: 'ArrowDown' });
    const selected = options.find(option => option.getAttribute('aria-selected') === 'true')!;
    expect(selected).toBeTruthy();
    expect(selected.id).not.toBe(initial.id);
    const activeDescendantAfterArrow = input.getAttribute('aria-activedescendant');
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Slash commands' })).toBeNull());
    expect(input.value).toBe('/mcp');
    expect(nativeOpenCodeRequest).not.toHaveBeenCalled();
    expect(interference).not.toHaveBeenCalled();
    expect(activeDescendantAfterArrow).toBe(selected.id);
  } finally {
    for (const name of ['jarvis:send', 'jarvis:steer', 'jarvis:cancel', 'jarvis:queue']) window.removeEventListener(name, interference);
  }
});
