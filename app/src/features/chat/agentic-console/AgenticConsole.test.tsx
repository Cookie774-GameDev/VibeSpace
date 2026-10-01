import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ChatActivityEvent } from '../activity/types';
import type { Message } from '@/types';
import { AgenticConsole, AgenticConsoleErrorBoundary } from './AgenticConsole';
import { DEFAULT_CONSOLE_PREFERENCES, saveConsolePreferences } from './preferences';

function message(
  id: string,
  role: Message['role'],
  createdAt: number,
  parts: Message['parts'],
  usage?: Message['usage'],
): Message {
  return {
    id: id as Message['id'],
    chat_id: 'chat-console' as Message['chat_id'],
    role,
    parts,
    created_at: createdAt,
    updated_at: createdAt,
    usage,
  };
}

describe('AgenticConsole', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    saveConsolePreferences(DEFAULT_CONSOLE_PREFERENCES);
  });

  function renderConsole(props: React.ComponentProps<typeof AgenticConsole>) {
    return render(
      <TooltipProvider>
        <AgenticConsole {...props} />
      </TooltipProvider>,
    );
  }

  it('leaves an empty chat canvas open instead of rendering a console placeholder', () => {
    const rendered = renderConsole({
      chatId: 'chat-console',
      messages: [],
      activity: [],
    });

    expect(rendered.container.querySelector('[data-agentic-console]')).toBeNull();
    expect(screen.queryByText('Ready for your next task')).toBeNull();
  });

  it('renders a compact truthful session strip and full-width semantic transcript', () => {
    const messages = [
      message('user', 'user', 10, [{ kind: 'text', text: 'Update the chat renderer.' }]),
      message('assistant', 'assistant', 30, [{ kind: 'text', text: 'The renderer is updated.' }], {
        input_tokens: 80,
        output_tokens: 20,
        model: 'local-model',
      }),
    ];
    const activity: ChatActivityEvent[] = [
      {
        id: 'edit',
        chatId: 'chat-console',
        kind: 'diff',
        status: 'done',
        title: 'Edited AgenticConsole.tsx',
        filePath: 'AgenticConsole.tsx',
        addedLines: 4,
        removedLines: 1,
        diff: '--- a/AgenticConsole.tsx\n+++ b/AgenticConsole.tsx\n-old\n+new',
        ts: 20,
        startedAt: 15,
        endedAt: 25,
      },
    ];

    renderConsole({ chatId: 'chat-console', messages, activity });

    expect(
      screen
        .getByRole('region', { name: 'Agentic chat console' })
        .getAttribute('data-console-theme'),
    ).toBe('vibespace-amber');
    expect(screen.getByLabelText('Session status').textContent).toContain('Complete');
    expect(screen.getByText('1 file')).toBeTruthy();
    expect(screen.getAllByText('+4')).toHaveLength(2);
    expect(screen.getAllByText('-1')).toHaveLength(2);
    expect(screen.getByText('100 tokens')).toBeTruthy();
    expect(screen.getByText('Update the chat renderer.')).toBeTruthy();
    expect(screen.getByText('The renderer is updated.')).toBeTruthy();
    expect(screen.getByText('+new').parentElement?.className).toContain('agentic-diff-line--add');
    expect(screen.getByText('-old').parentElement?.className).toContain(
      'agentic-diff-line--remove',
    );
  });

  it('routes live work through all seven structured activity motions', () => {
    const activity: ChatActivityEvent[] = [
      {
        id: 'think',
        chatId: 'chat-console',
        kind: 'agent',
        category: 'thinking',
        status: 'running',
        title: 'Working',
        ts: 10,
      },
      {
        id: 'read',
        chatId: 'chat-console',
        kind: 'file',
        category: 'file',
        status: 'running',
        title: 'Working',
        filePath: 'src/App.tsx',
        ts: 20,
      },
      {
        id: 'agents',
        chatId: 'chat-console',
        kind: 'subagent',
        category: 'coordination',
        status: 'running',
        title: 'Working',
        ts: 30,
      },
      {
        id: 'write',
        chatId: 'chat-console',
        kind: 'diff',
        category: 'writing',
        status: 'running',
        title: 'Working',
        filePath: 'src/App.tsx',
        diff: '+updated',
        ts: 40,
      },
      {
        id: 'context',
        chatId: 'chat-console',
        kind: 'url',
        category: 'context',
        status: 'running',
        title: 'Working',
        ts: 50,
      },
      {
        id: 'learning',
        chatId: 'chat-console',
        kind: 'tool',
        category: 'learning',
        status: 'running',
        title: 'Working',
        ts: 60,
      },
      {
        id: 'respond',
        chatId: 'chat-console',
        kind: 'agent',
        category: 'response',
        status: 'running',
        title: 'Working',
        ts: 70,
      },
    ];

    const rendered = renderConsole({
      chatId: 'chat-console',
      messages: [],
      activity,
      sessionEvidence: { status: 'running', currentOperation: 'Working' },
    });

    const motions = rendered.container.querySelectorAll('[data-agent-motion]');
    expect([...motions].map((motion) => motion.getAttribute('data-agent-motion'))).toEqual([
      'cursor-forge',
      'stack-shift',
      'nine-dot-fold',
      'code-shimmer',
      'twin-loop',
      'breathing-brackets',
      'glyph-current',
    ]);
  });

  it('switches motion on a rapid structured activity transition and becomes still at completion', () => {
    vi.useFakeTimers();
    const baseActivity: ChatActivityEvent = {
      id: 'phase',
      chatId: 'chat-console',
      kind: 'agent',
      category: 'thinking',
      status: 'pending',
      title: 'Working',
      ts: 10,
    };
    const rendered = renderConsole({
      chatId: 'chat-console',
      messages: [],
      activity: [baseActivity],
      compact: true,
      sessionEvidence: { status: 'running', currentOperation: 'Working' },
    });

    expect(
      rendered.container.querySelector('[data-agent-motion]')?.getAttribute('data-agent-motion'),
    ).toBe('cursor-forge');
    expect(
      rendered.container
        .querySelector('[data-agent-motion]')
        ?.getAttribute('data-agent-motion-size'),
    ).toBe('compact');

    rendered.rerender(
      <TooltipProvider>
        <AgenticConsole
          chatId="chat-console"
          messages={[]}
          activity={[
            {
              ...baseActivity,
              category: 'response',
              status: 'running',
              ts: 20,
            },
          ]}
          compact
          sessionEvidence={{ status: 'running', currentOperation: 'Responding' }}
        />
      </TooltipProvider>,
    );
    expect(
      rendered.container.querySelector('[data-agent-motion]')?.getAttribute('data-agent-motion'),
    ).toBe('glyph-current');

    rendered.rerender(
      <TooltipProvider>
        <AgenticConsole
          chatId="chat-console"
          messages={[]}
          activity={[
            {
              ...baseActivity,
              category: 'response',
              status: 'done',
              ts: 30,
              endedAt: 30,
            },
          ]}
          compact
          sessionEvidence={{ status: 'done', currentOperation: 'Complete' }}
        />
      </TooltipProvider>,
    );
    expect(
      rendered.container
        .querySelector('[data-agent-motion="glyph-current"]')
        ?.getAttribute('data-agent-motion-presence'),
    ).toBe('exiting');
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(rendered.container.querySelector('[data-agent-motion]')).toBeNull();
  });

  it('stops reasoning motion after the Jarvis run completes', () => {
    const rendered = renderConsole({
      chatId: 'chat-console',
      messages: [
        message('assistant-reasoning', 'assistant', 10, [
          { kind: 'reasoning', text: 'Checked the implementation and its focused test.' },
          {
            kind: 'tool_call',
            call_id: 'completed-command',
            tool: 'terminal.exec',
            args: { command: 'npm test' },
          },
          { kind: 'text', text: 'The verified change is complete.' },
        ]),
      ],
      activity: [
        {
          id: 'agent-done',
          chatId: 'chat-console',
          kind: 'agent',
          status: 'done',
          title: '@jarvis finished',
          ts: 20,
          endedAt: 20,
        },
      ],
      sessionEvidence: { status: 'done', currentOperation: 'Complete' },
    });

    expect(screen.getByText('Reasoning')).toBeTruthy();
    expect(rendered.container.querySelector('[data-agent-motion]')).toBeNull();
  });

  it('keeps statusless historical commands and reasoning still during later live work', () => {
    const rendered = renderConsole({
      chatId: 'chat-console',
      messages: [
        message('assistant-history', 'assistant', 10, [
          {
            kind: 'reasoning',
            text: 'Historical reasoning without structured lifecycle evidence.',
          },
          {
            kind: 'tool_call',
            call_id: 'historical-command',
            tool: 'terminal.exec',
            args: { command: 'npm test' },
          },
        ]),
      ],
      activity: [
        {
          id: 'later-response',
          chatId: 'chat-console',
          kind: 'agent',
          category: 'response',
          status: 'running',
          title: 'Preparing a later response',
          ts: 20,
        },
      ],
      sessionEvidence: { status: 'running', currentOperation: 'Preparing a later response' },
    });

    expect(
      screen.getByText('Reasoning').closest('details')?.querySelector('[data-agent-motion]'),
    ).toBeNull();
    expect(
      screen
        .getByRole('article', { name: 'Command npm test' })
        .querySelector('[data-agent-motion]'),
    ).toBeNull();
    expect(
      [...rendered.container.querySelectorAll('[data-agent-motion]')].map((motion) =>
        motion.getAttribute('data-agent-motion'),
      ),
    ).toEqual(['glyph-current']);
  });

  it('changes only the scoped console profile and exposes classic view', () => {
    const globalTheme = document.documentElement.dataset.theme;
    renderConsole({
      chatId: 'chat-console',
      messages: [],
      activity: [],
      sessionEvidence: {
        status: 'running',
        currentOperation: 'Preparing workspace',
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Chat console settings' }));
    fireEvent.change(screen.getByLabelText('Console theme'), { target: { value: 'oled-void' } });

    expect(
      screen
        .getByRole('region', { name: 'Agentic chat console' })
        .getAttribute('data-console-theme'),
    ).toBe('oled-void');
    expect(document.documentElement.dataset.theme).toBe(globalTheme);

    fireEvent.click(screen.getByRole('button', { name: 'Use classic chat view' }));
    expect(screen.getByText('Classic chat view selected.')).toBeTruthy();
  });

  it('shows only canonical run actions supplied by the host and invokes them explicitly', () => {
    const cancel = vi.fn();
    const retry = vi.fn();
    renderConsole({
      chatId: 'chat-console',
      messages: [],
      activity: [],
      sessionEvidence: {
        status: 'running',
        currentOperation: 'Running focused tests',
        model: 'verified-model',
        startedAt: 100,
      },
      actions: { cancel, retry },
    });

    expect(screen.getByLabelText('Session status').textContent).toContain('Running');
    expect(screen.getByText('Running focused tests')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry run' }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('offers bounded transcript controls from the session drawer', () => {
    renderConsole({
      chatId: 'chat-console',
      messages: [],
      activity: [],
      sessionEvidence: {
        status: 'running',
        currentOperation: 'Preparing workspace',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Chat console settings' }));

    expect(screen.getByRole('button', { name: 'Expand all transcript details' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse all transcript details' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy session summary' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export session' })).toBeTruthy();
  });

  it('mounts exactly one mini command center with metrics and session actions on normal agentic chat', () => {
    const messages = [
      message('user', 'user', 10, [
        { kind: 'text', text: 'Stay on this chat and finish the task.' },
      ]),
      message(
        'assistant',
        'assistant',
        20,
        [{ kind: 'text', text: 'Working through the steps now.' }],
        {
          input_tokens: 40,
          output_tokens: 12,
          model: 'local-model',
        },
      ),
    ];

    const rendered = renderConsole({
      chatId: 'chat-console',
      messages,
      activity: [],
    });

    const panels = rendered.container.querySelectorAll('[data-testid="jarvis-session-panel"]');
    expect(panels).toHaveLength(1);
    expect(screen.getByLabelText('Session status')).toBeTruthy();
    expect(screen.getByLabelText('Open session details')).toBeTruthy();
    expect(screen.getByText(/tokens/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Chat console settings' }));
    expect(screen.getByRole('button', { name: 'Expand all transcript details' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse all transcript details' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy session summary' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export session' })).toBeTruthy();
  });

  it('toggles transcript details with Ctrl+T while the console is active', () => {
    renderConsole({
      chatId: 'chat-console',
      messages: [
        message('tool', 'assistant', 1, [
          { kind: 'tool_call', tool: 'read_file', args: { path: 'README.md' }, call_id: 'call-1' },
          { kind: 'tool_result', call_id: 'call-1', result: 'tool output' },
        ]),
      ],
      activity: [],
    });
    const detail = document.querySelector<HTMLDetailsElement>('details');
    expect(detail?.open).toBe(false);
    fireEvent.keyDown(window, { key: 't', ctrlKey: true });
    expect(detail?.open).toBe(true);
    fireEvent.keyDown(window, { key: 't', ctrlKey: true });
    expect(detail?.open).toBe(false);
  });

  it('pages older history without mounting the entire canonical transcript', () => {
    const messages = Array.from({ length: 450 }, (_, index) =>
      message(`m-${index}`, 'user', index, [{ kind: 'text', text: `Prompt ${index}` }]),
    );
    renderConsole({ chatId: 'chat-console', messages, activity: [] });

    expect(screen.queryByText('Prompt 0')).toBeNull();
    expect(screen.getByText('Prompt 449')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Load 50 older events/i }));
    expect(screen.getByText('Prompt 0')).toBeTruthy();
  });

  it('keeps interactive approval messages on the classic safe renderer', () => {
    const messages = [
      message('approval', 'assistant', 1, [
        {
          kind: 'action_proposal',
          call_id: 'proposal',
          action_id: 'nav.goto',
          params: { route: 'files' },
          rationale: 'Open Files',
          status: 'pending',
        },
      ]),
    ];
    const rendered = renderConsole({ chatId: 'chat-console', messages, activity: [] });

    expect(
      rendered.container.querySelector('[data-agentic-fallback="structured-message"]'),
    ).toBeTruthy();
    expect(rendered.container.querySelector('[data-action-id="nav.goto"]')).toBeTruthy();
    expect(screen.getByText('nav.goto')).toBeTruthy();
  });
});

describe('AgenticConsoleErrorBoundary', () => {
  it('renders the provided classic fallback after a projection failure', () => {
    const originalError = console.error;
    console.error = () => undefined;
    function Thrower(): React.JSX.Element {
      throw new Error('projection failed');
    }
    render(
      <AgenticConsoleErrorBoundary fallback={<div>Classic transcript restored</div>}>
        <Thrower />
      </AgenticConsoleErrorBoundary>,
    );
    console.error = originalError;

    expect(screen.getByText('Classic transcript restored')).toBeTruthy();
  });
});
