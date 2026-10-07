import { fireEvent, render, screen, within, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Message } from '@/types';
import { useAuthStore } from '@/stores/auth';
import { useJarvisInteractionStore } from '@/features/jarvis-interaction/sessionStore';
import { useJarvisTaskRunStore } from '@/features/jarvis-runs/taskRunStore';
import { TooltipProvider } from '@/components/ui/tooltip';

const fixture = vi.hoisted(() => ({
  messages: {} as Record<string, Message[]>, older: {} as Record<string, boolean>,
  empty: [] as Message[], activity: [], loadOlder: vi.fn(),
}));
vi.mock('./hooks', () => ({ usePagedChatMessages: (chatId: string | null) => ({
  messages: fixture.messages[String(chatId)] ?? fixture.empty,
  hasOlder: fixture.older[String(chatId)] ?? false,
  loadOlder: () => fixture.loadOlder(chatId),
}) }));
vi.mock('./activity', () => ({ ChatActivityTimeline: () => null, useUnifiedChatActivity: () => fixture.activity }));
vi.mock('@/features/jarvis-command-center/JarvisCommandCenter', () => ({ useJarvisCommandCenterBinding: () => undefined }));
vi.mock('@/features/jarvis-memory/JarvisMemoryStatus', () => ({ JarvisMemoryStatus: () => null }));
vi.mock('./agentic-console', () => ({
  AgenticConsoleErrorBoundary: ({ children }: { children: ReactNode }) => children,
  AgenticConsole: ({ chatId, messages }: { chatId: string; messages: readonly Message[] }) => (
    <div data-rendered-chat={chatId}>{messages.map(message => <div key={String(message.id)}>{String(message.id)}</div>)}</div>
  ),
}));
import { ChatThread } from './ChatThread';

const originalAuth = useAuthStore.getState();
const originalInteraction = useJarvisInteractionStore.getState();
const originalRuns = useJarvisTaskRunStore.getState();
function rows(chatId: string, count: number, first = 1): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${chatId}-${first + index}` as Message['id'], chat_id: chatId as Message['chat_id'], role: 'assistant',
    // Equal tail sizes deliberately exercise selection changes with unchanged
    // message-count and text-size dependencies.
    parts: [{ kind: 'text', text: 'Same sized fixture response.' }],
    created_at: first + index, updated_at: first + index,
  }));
}
function view(chatId: string) {
  // No chat key: matches Inspector and Workbench, unlike keyed ChatWorkspace.
  return <TooltipProvider><ChatThread chatId={chatId} compact /></TooltipProvider>;
}
function geometry(log: HTMLElement, initialHeight = 1000) {
  let top = initialHeight - 400;
  const size = { height: initialHeight, viewport: 400, writes: [] as number[] };
  Object.defineProperties(log, {
    scrollHeight: { configurable: true, get: () => size.height },
    clientHeight: { configurable: true, get: () => size.viewport },
    scrollTop: { configurable: true, get: () => top, set: value => {
      top = Math.max(0, Math.min(Number(value), size.height - size.viewport));
      size.writes.push(top);
    } },
  });
  return size;
}
function readAt(log: HTMLElement, position: number) {
  log.scrollTop = position; fireEvent.scroll(log);
}
beforeEach(() => {
  fixture.messages = {}; fixture.older = {}; fixture.loadOlder.mockReset();
  useAuthStore.setState({ localUserId: null, cloudSession: null });
  useJarvisInteractionStore.setState({ agentsByChat: {}, modesByChat: {}, planSafeApprovalsByChat: {} });
  useJarvisTaskRunStore.setState({ runs: {}, manualRecoveryByRun: {} });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  useAuthStore.setState(originalAuth); useJarvisInteractionStore.setState(originalInteraction);
  useJarvisTaskRunStore.setState(originalRuns);
});

describe('reused compact ChatThread scroll scope', () => {
  it('opens a newly selected chat at its latest content and follows its subsequent append', () => {
    fixture.messages.a = rows('a', 2); fixture.messages.b = rows('b', 3);
    const mounted = render(view('a')); const log = screen.getByRole('log'); const size = geometry(log);
    readAt(log, 180);
    fixture.messages.a = rows('a', 3); size.height = 1200; mounted.rerender(view('a'));
    expect(log.scrollTop).toBe(180);
    expect(screen.getByRole('button', { name: 'Jump to latest activity' })).toBeTruthy();

    size.height = 1600; mounted.rerender(view('b'));
    expect(screen.getByRole('log')).toBe(log);
    expect(log.scrollTop).toBe(1200);
    expect(screen.queryByRole('button', { name: 'Jump to latest activity' })).toBeNull();
    fixture.messages.b = rows('b', 4); size.height = 1800; mounted.rerender(view('b'));
    expect(log.scrollTop).toBe(1400);
  });

  it('never yanks a same-chat history reader for appended or streaming text', () => {
    fixture.messages.a = rows('a', 2);
    const mounted = render(view('a')); const log = screen.getByRole('log'); const size = geometry(log);
    readAt(log, 150);
    fixture.messages.a = rows('a', 3); size.height = 1300; mounted.rerender(view('a'));
    expect(log.scrollTop).toBe(150);
    fixture.messages.a = fixture.messages.a.map((message, index) => index === 2
      ? { ...message, parts: [{ kind: 'text', text: 'More streamed answer text arrived.' }] } : message);
    size.height = 1400; mounted.rerender(view('a')); expect(log.scrollTop).toBe(150);
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest activity' }));
    expect(log.scrollTop).toBe(1000);
    fixture.messages.a = rows('a', 4); size.height = 1600; mounted.rerender(view('a'));
    expect(log.scrollTop).toBe(1200);
  });

  it('keeps each pane independent when another pane changes its selected chat', () => {
    fixture.messages.a = rows('a', 2); fixture.messages.b = rows('b', 2); fixture.messages.c = rows('c', 3);
    const panes = (left: string) => <TooltipProvider>
      <div data-testid="left"><ChatThread chatId={left} compact /></div>
      <div data-testid="right"><ChatThread chatId="b" compact /></div>
    </TooltipProvider>;
    const mounted = render(panes('a'));
    const left = within(screen.getByTestId('left')).getByRole('log');
    const right = within(screen.getByTestId('right')).getByRole('log');
    const leftSize = geometry(left); const rightSize = geometry(right);
    readAt(left, 180);
    fixture.messages.a = rows('a', 3); fixture.messages.b = rows('b', 3);
    leftSize.height = 1200; rightSize.height = 1400; mounted.rerender(panes('a'));
    expect(left.scrollTop).toBe(180); expect(right.scrollTop).toBe(1000);
    readAt(right, 260); leftSize.height = 1600; mounted.rerender(panes('c'));
    expect(left.scrollTop).toBe(1200); expect(right.scrollTop).toBe(260);
  });

  it('preserves the same-chat visual anchor when a requested older page arrives', () => {
    fixture.messages.a = rows('a', 2, 3); fixture.older.a = true;
    const mounted = render(view('a')); const log = screen.getByRole('log'); const size = geometry(log);
    readAt(log, 10); expect(fixture.loadOlder).toHaveBeenCalledExactlyOnceWith('a');
    fixture.messages.a = rows('a', 4); fixture.older.a = false;
    size.height = 1600; mounted.rerender(view('a'));
    expect(log.scrollTop).toBe(610);
  });

  it('discards an old pending history anchor before a new chat is laid out', () => {
    fixture.messages.a = rows('a', 2, 3); fixture.older.a = true; fixture.messages.b = rows('b', 3);
    const mounted = render(view('a')); const log = screen.getByRole('log'); const size = geometry(log);
    readAt(log, 10); expect(fixture.loadOlder).toHaveBeenCalledExactlyOnceWith('a');
    size.writes.length = 0; size.height = 1400; mounted.rerender(view('b'));
    expect(log.scrollTop).toBe(1000);
    expect(size.writes).not.toContain(410);
    fixture.messages.a = rows('a', 4); mounted.rerender(view('b'));
    expect(log.scrollTop).toBe(1000);
    expect(fixture.loadOlder).toHaveBeenCalledOnce();
  });

  it('preserves the most recent reading position while an older page remains pending', () => {
    fixture.messages.a = rows('a', 2, 3); fixture.older.a = true;
    const mounted = render(view('a')); const log = screen.getByRole('log'); const size = geometry(log);
    readAt(log, 10); expect(fixture.loadOlder).toHaveBeenCalledExactlyOnceWith('a');
    readAt(log, 250); expect(fixture.loadOlder).toHaveBeenCalledOnce();
    fixture.messages.a = rows('a', 4); fixture.older.a = false;
    size.height = 1600; mounted.rerender(view('a'));
    expect(log.scrollTop).toBe(850);
    expect(fixture.loadOlder).toHaveBeenCalledOnce();
  });

  it.each(['scroll', 'button'] as const)(
    'honors a newer move to latest while an older page remains pending (%s)', action => {
      fixture.messages.a = rows('a', 2, 3); fixture.older.a = true;
      const mounted = render(view('a')); const log = screen.getByRole('log'); const size = geometry(log);
      readAt(log, 10); expect(fixture.loadOlder).toHaveBeenCalledOnce();
      // Streaming changes the tail without resolving the pending older page.
      fixture.messages.a = fixture.messages.a.map((message, index) => index === 1
        ? { ...message, parts: [{ kind: 'text', text: 'New streamed activity remains below.' }] } : message);
      mounted.rerender(view('a'));
      if (action === 'scroll') readAt(log, 600);
      else fireEvent.click(screen.getByRole('button', { name: 'Jump to latest activity' }));
      expect(log.scrollTop).toBe(600);
      size.writes.length = 0;
      fixture.messages.a = rows('a', 4); fixture.older.a = false;
      size.height = 1600; mounted.rerender(view('a'));
      expect(log.scrollTop).toBe(1200);
      expect(size.writes).not.toContain(610);
      expect(fixture.loadOlder).toHaveBeenCalledOnce();
    },
  );
});
