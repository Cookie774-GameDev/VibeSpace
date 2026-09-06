import * as React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ChatActivityEvent } from '../activity/types';
import { AgentChecklistBar } from '../AgentChecklistBar';
import type { Message } from '@/types';
import {
  AgenticConsole,
  AgenticConsoleErrorBoundary,
  shouldRenderInlineLegacyLedger,
} from './AgenticConsole';
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
  it('keeps follow-up live activity after its own prompt rather than the previous answer', () => {
    const rendered = renderConsole({chatId: 'chat-console', messages: [
      message('old-user', 'user', 1, [{kind: 'text', text: 'Old request'}]),
      message('old-answer', 'assistant', 2, [{kind: 'text', text: 'Old answer'}]),
      message('new-user', 'user', 10, [{kind: 'text', text: 'Current request'}]),
    ], activity: [{id: 'new-read', chatId: 'chat-console', kind: 'tool', category: 'file', filePath: 'alpha.txt', subtitle: 'alpha.txt', status: 'running', title: 'Reading file', ts: 11}], sessionEvidence: {status: 'running'}});
    const prompt = screen.getByText('Current request');
    const ledger = rendered.container.querySelector('[data-assistant-activity-ledger="true"]');
    expect(ledger).not.toBeNull();
    expect(Boolean(prompt.compareDocumentPosition(ledger!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('discloses authoritative file additions and removals without claiming failed edits succeeded', () => {
    const rendered = renderConsole({
      chatId: 'chat-console',
      messages: [message('diff-answer', 'assistant', 3, [{ kind: 'text', text: 'The edit failed.' }])],
      activity: [{ id: 'failed-diff', chatId: 'chat-console', kind: 'diff', status: 'error',
        title: 'Edit failed', filePath: 'src/alpha.txt', diff: '-alpha=old\n+alpha=new',
        addedLines: 1, removedLines: 1, ts: 2 }],
      sessionEvidence: { status: 'completed' },
    });
    const disclosure = screen.getByRole('button', { name: /Edit failed.*src\/alpha.txt/i });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('alpha=new')).toBeNull();
    fireEvent.click(disclosure);
    expect(rendered.container.querySelector('.agentic-diff-line--add')?.textContent).toContain('alpha=new');
    expect(rendered.container.querySelector('.agentic-diff-line--remove')?.textContent).toContain('alpha=old');
    expect(screen.queryByText('Edited files')).toBeNull();
  });
  it('preserves provider-exposed thinking in the native tool chronology, collapsed by default', () => {
    renderConsole({
      chatId: 'chat-console',
      messages: [message('exposed-thinking', 'assistant', 2, [
        { kind: 'reasoning', text: 'I will check both fixture files.' },
        { kind: 'tool_call', call_id: 'read-fixture', tool: 'read', args: { path: 'fixture.txt' } },
        { kind: 'tool_result', call_id: 'read-fixture', result: { status: 'completed' } },
        { kind: 'text', text: 'Both files were checked.' },
      ], { model: 'opencode-go/deepseek-v4-flash-vision-exp' })],
      activity: [],
      sessionEvidence: { status: 'completed' },
    });
    const toggle = screen.getByRole('button', { name: 'Thinking' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('I will check both fixture files.')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText('I will check both fixture files.')).toBeTruthy();
    expect(screen.getByText('Both files were checked.')).toBeTruthy();
  });
  it('keeps the warm prompt band while response phases read as one continuous transcript', () => {
    const stylesheet = readFileSync(
      resolve(process.cwd(), 'src/features/chat/agentic-console/agentic-console.css'),
      'utf8',
    );

    expect(stylesheet).toMatch(
      /\.agentic-prompt-band\s*\{[^}]*border:\s*1px solid var\(--console-line\);/s,
    );
    expect(stylesheet).toMatch(/\.agentic-prompt-band\s*\{[^}]*background:\s*linear-gradient\(/s);
    expect(stylesheet).toMatch(/\.agentic-answer\s*\{[^}]*border:\s*0;/s);
    expect(stylesheet).toMatch(/\.agentic-answer\.is-final\s*\{[^}]*background:\s*transparent;/s);
    expect(stylesheet).toMatch(
      /\.agentic-live-status__text\s*\{[^}]*background:\s*linear-gradient\(/s,
    );
    expect(stylesheet).toMatch(/@keyframes\s+agentic-live-status-shimmer/);
    expect(stylesheet).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.agentic-live-status__text/s,
    );
  });

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
    expect(screen.getByRole('status', { name: 'Session status' }).textContent).toContain('Complete');
    expect(screen.getByRole('group', { name: 'Agentic session summary' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Agentic transcript' })).toBeTruthy();
    expect(screen.getByText('1 file')).toBeTruthy();
    expect(screen.getAllByText('+4')).toHaveLength(1);
    expect(screen.getAllByText('-1')).toHaveLength(1);
    expect(screen.getByText('100 tokens')).toBeTruthy();
    expect(screen.getByText('Update the chat renderer.')).toBeTruthy();
    expect(screen.getByText('The renderer is updated.')).toBeTruthy();
    expect(screen.queryByRole('article', { name: 'Diff AgenticConsole.tsx' })).toBeNull();
  });

  it('renders completed OpenCode work expanded by default and collapses only its public chronology', () => {
    renderConsole({
      chatId: 'chat-console',
      messages: [
        message('user', 'user', 1_000, [{ kind: 'text', text: 'Build the game.' }]),
        {
          ...message(
            'assistant',
            'assistant',
            2_000,
            [
              { kind: 'text', text: 'I’m inspecting the existing game files.' },
              {
                kind: 'tool_call',
                call_id: 'read-game',
                tool: 'read',
                args: { path: 'C:\\private\\game.js' },
              },
              { kind: 'tool_result', call_id: 'read-game', result: { status: 'completed' } },
              { kind: 'text', text: 'The complete game is ready.' },
            ],
            { model: 'opencode-go/deepseek-v4-flash-vision-exp' },
          ),
          updated_at: 7_000,
        },
      ],
      activity: [],
      sessionEvidence: { status: 'completed', startedAt: 2_000, endedAt: 7_000 },
    });

    const audit = screen.getByRole('button', { name: 'Collapse completed work details' });
    const prompt = screen.getByText('Build the game.').closest('.agentic-prompt-band');
    const firstCheckpoint = screen
      .getByText('I’m inspecting the existing game files.')
      .closest('[data-native-assistant-checkpoint]');
    expect(audit.getAttribute('aria-expanded')).toBe('true');
    expect(audit.textContent).toContain('Worked for 5s · 1 action');
    expect(audit.textContent).toContain('Read 1');
    expect(
      Boolean(prompt && prompt.compareDocumentPosition(audit) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(
      audit.compareDocumentPosition(firstCheckpoint!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText('I’m inspecting the existing game files.')).toBeTruthy();
    expect(screen.getByText('The complete game is ready.')).toBeTruthy();

    fireEvent.click(audit);

    expect(screen.queryByText('I’m inspecting the existing game files.')).toBeNull();
    expect(screen.getByText('The complete game is ready.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /show activity details/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand completed work details' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /Doing now|Awaiting your next request|Blockers/iu,
    );
  });

  it.each(['blocked', 'error', 'cancelled', 'partial'])(
    'does not invent a four-state inspector for a terminal %s response without tool evidence',
    (status) => {
      renderConsole({
        chatId: 'chat-console',
        messages: [message('user', 'user', 10, [{ kind: 'text', text: 'Continue safely.' }])],
        activity: [],
        sessionEvidence: { status, currentOperation: 'Untrusted stale operation text' },
      });

      expect(screen.queryByRole('status', { name: 'Session completion status' })).toBeNull();
      expect(screen.queryByRole('button', { name: /completed work details/i })).toBeNull();
    },
  );

  it('does not present a terminal inspector while the session is still running', () => {
    renderConsole({
      chatId: 'chat-console',
      messages: [message('user', 'user', 10, [{ kind: 'text', text: 'Keep working.' }])],
      activity: [
        {
          id: 'running-check',
          chatId: 'chat-console',
          kind: 'tool',
          category: 'learning',
          status: 'running',
          title: 'Running focused checks',
          ts: 20,
        },
      ],
      sessionEvidence: { status: 'running', currentOperation: 'Running focused checks' },
    });

    expect(screen.queryByRole('status', { name: 'Session completion status' })).toBeNull();
    expect(screen.queryByRole('button', { name: /completed work details/i })).toBeNull();
  });

  it('projects 250,000 latest-turn events without spreading timestamp arrays', () => {
    const activity = Array.from<unknown, ChatActivityEvent>({ length: 250_000 }, (_, index) => ({
      id: `scale-${index}`,
      chatId: 'chat-console',
      kind: 'agent',
      category: 'response',
      status: 'done',
      title: 'Recorded activity',
      ts: 1_000 + index,
      endedAt: 1_000 + index,
    }));

    const rendered = renderConsole({
      chatId: 'chat-console',
      messages: [
        message('user-scale', 'user', 999, [{ kind: 'text', text: 'Restore the long run.' }]),
        message('assistant-scale', 'assistant', 1_000, [
          { kind: 'text', text: 'Recorded activity is restored.' },
        ]),
      ],
      activity,
      sessionEvidence: { status: 'running', currentOperation: 'Restoring recorded activity' },
    });

    expect(rendered.container.querySelector('[data-agentic-console="true"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load 100 older events' })).toBeTruthy();
  });

  it('persists live work as ordered continuous-response phase disclosures', () => {
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

    const disclosures = screen.getAllByRole('button', { name: /show activity details/i });
    expect(disclosures).toHaveLength(3);
    expect(disclosures.map((disclosure) => disclosure.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Context · 1 action'),
        expect.stringContaining('Tools · 2 actions'),
      ]),
    );
    expect(rendered.container.querySelectorAll('[data-agent-motion]')).toHaveLength(1);
    expect(
      rendered.container.querySelector('[data-agent-motion]')?.getAttribute('data-agent-motion'),
    ).toBe('glyph-current');
    expect(screen.queryByText('Jarvis status')).toBeNull();
  });

  it('does not render provider lifecycle receipts as separate transcript cards', () => {
    const activity: ChatActivityEvent[] = [
      {
        id: 'compile',
        chatId: 'chat-console',
        kind: 'agent',
        category: 'context',
        status: 'done',
        title: 'Jarvis status',
        detail: 'The protected request is being compiled.',
        ts: 10,
        endedAt: 12,
      },
      {
        id: 'dispatch',
        chatId: 'chat-console',
        kind: 'tool',
        status: 'running',
        title: 'Jarvis model activity',
        detail: 'The protected provider request is running.',
        ts: 20,
      },
      {
        id: 'response',
        chatId: 'chat-console',
        kind: 'agent',
        category: 'response',
        status: 'running',
        title: 'Jarvis is preparing the final response',
        ts: 30,
      },
    ];

    renderConsole({
      chatId: 'chat-console',
      messages: [message('user', 'user', 1, [{ kind: 'text', text: 'Build the game.' }])],
      activity,
      sessionEvidence: { status: 'running', currentOperation: 'Preparing the response' },
    });

    expect(screen.getByText('Build the game.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /show activity details/i })).toBeNull();
    expect(screen.queryByText('Jarvis status')).toBeNull();
    expect(screen.queryByText('Jarvis model activity')).toBeNull();
    expect(screen.queryByText('The protected request is being compiled.')).toBeNull();
    expect(screen.queryByText('The protected provider request is running.')).toBeNull();
  });

  it('anchors the completed audit above assistant prose while preserving safe command receipts', () => {
    const rendered = renderConsole({
      chatId: 'chat-console',
      messages: [
        message('user', 'user', 1, [{ kind: 'text', text: 'Run the checks.' }]),
        message('assistant', 'assistant', 2, [
          { kind: 'text', text: 'The focused checks are complete.' },
          { kind: 'tool_call', call_id: 'command-1', tool: 'shell.exec', args: { secret: 'x' } },
          { kind: 'tool_result', call_id: 'command-1', result: { exitCode: 0 } },
        ]),
      ],
      activity: [
        {
          id: 'complete',
          chatId: 'chat-console',
          kind: 'agent',
          category: 'response',
          status: 'done',
          title: 'Completed',
          ts: 3,
          endedAt: 4,
        },
      ],
      sessionEvidence: { status: 'completed', currentOperation: 'Complete' },
    });

    const answer = screen.getByText('The focused checks are complete.');
    const prompt = screen.getByText('Run the checks.').closest('.agentic-prompt-band');
    const ledger = rendered.container.querySelector('[data-assistant-activity-ledger="true"]');
    const audit = screen.getByRole('button', { name: 'Collapse completed work details' });
    expect(ledger).toBeTruthy();
    expect(ledger?.getAttribute('data-ledger-active')).toBe('false');
    expect(
      Boolean((prompt as Node).compareDocumentPosition(audit) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(Boolean(audit.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
    expect(
      Boolean(answer.compareDocumentPosition(ledger as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /show activity details/i }));
    expect(screen.getByText('Ran command')).toBeTruthy();
    expect(rendered.container.textContent).not.toContain('secret');
  });

  it('marks only the latest tool-bearing response ledger active while the session is running', () => {
    const rendered = renderConsole({
      chatId: 'chat-console',
      messages: [
        message('user', 'user', 10, [{ kind: 'text', text: 'Read Composer.tsx.' }]),
        message('assistant', 'assistant', 11, [
          { kind: 'text', text: '' },
          { kind: 'tool_call', call_id: 'read-live', tool: 'read', args: { path: 'Composer.tsx' } },
        ]),
      ],
      activity: [
        {
          id: 'live-response',
          chatId: 'chat-console',
          kind: 'agent',
          category: 'file',
          status: 'running',
          title: 'Reading project file',
          ts: 11,
        },
      ],
      sessionEvidence: { status: 'running', currentOperation: 'Reading project file' },
    });

    const ledger = rendered.container.querySelector('[data-assistant-activity-ledger="true"]');
    expect(ledger?.getAttribute('data-ledger-active')).toBe('true');
    expect(screen.getByText(/I’m reading Composer\.tsx now\./i)).toBeTruthy();
  });

  it('keeps the single turn ledger inline before assistant context references', () => {
    const rendered = renderConsole({
      chatId: 'chat-console',
      messages: [
        message('user', 'user', 1, [{ kind: 'text', text: 'Use the protected context.' }]),
        message('assistant', 'assistant', 2, [
          { kind: 'text', text: 'I found the relevant project evidence.' },
          {
            kind: 'tool_call',
            call_id: 'context-read',
            tool: 'read',
            args: { path: 'C:\\private\\context\\ResolvedContext.ts' },
          },
          { kind: 'tool_result', call_id: 'context-read', result: { content: 'private' } },
          {
            kind: 'jarvis_source_ref',
            source: {
              id: 'source-private',
              kind: 'project_file',
              label: 'Resolved app context',
              trust: 'app_verified',
              sensitivity: 'restricted',
            },
          },
        ]),
      ],
      activity: [
        {
          id: 'context-complete',
          chatId: 'chat-console',
          kind: 'agent',
          category: 'context',
          status: 'done',
          title: 'Prepared project context',
          ts: 3,
          endedAt: 4,
        },
      ],
      sessionEvidence: { status: 'completed', currentOperation: 'Complete' },
    });

    const prose = screen.getByText('I found the relevant project evidence.');
    const source = screen.getByText('Resolved app context');
    const ledgers = rendered.container.querySelectorAll('[data-assistant-activity-ledger="true"]');
    expect(ledgers).toHaveLength(1);
    const ledger = ledgers[0];
    expect(Boolean(prose.compareDocumentPosition(ledger) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
    expect(Boolean(ledger.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: /show activity details/i }));
    expect(screen.getByText('Read file')).toBeTruthy();
    expect(screen.getByText('ResolvedContext.ts')).toBeTruthy();
    expect(rendered.container.textContent).not.toContain('C:\\private');
  });

  it('keeps each historical response-phase disclosure with its own durable evidence', () => {
    renderConsole({
      chatId: 'chat-console',
      messages: [
        message('user-old', 'user', 1, [{ kind: 'text', text: 'First request.' }]),
        message('assistant-old', 'assistant', 2, [
          { kind: 'text', text: 'First response.' },
          { kind: 'tool_call', call_id: 'old-command', tool: 'shell.exec', args: {} },
          { kind: 'tool_result', call_id: 'old-command', result: { exitCode: 0 } },
        ]),
        message('user-new', 'user', 10, [{ kind: 'text', text: 'Second request.' }]),
        message('assistant-new', 'assistant', 11, [{ kind: 'text', text: 'Second response.' }]),
      ],
      activity: [
        {
          id: 'old-complete',
          chatId: 'chat-console',
          kind: 'agent',
          category: 'response',
          status: 'done',
          title: 'Old completed activity',
          ts: 3,
          endedAt: 4,
        },
        {
          id: 'new-complete',
          chatId: 'chat-console',
          kind: 'agent',
          category: 'response',
          status: 'done',
          title: 'New completed activity',
          ts: 12,
          endedAt: 13,
        },
      ],
      sessionEvidence: { status: 'completed', currentOperation: 'Complete' },
    });

    expect(screen.getAllByRole('button', { name: /show activity details/i })).toHaveLength(1);
  });

  it('uses a same-turn canonical duration when correlated event timestamps have no interval', () => {
    renderConsole({
      chatId: 'chat-console',
      messages: [
        message('user', 'user', 1_000, [{ kind: 'text', text: 'Run the verified task.' }]),
        message('assistant', 'assistant', 8_000, [{ kind: 'text', text: 'Task complete.' }]),
      ],
      activity: [
        {
          id: 'completed-at-one-timestamp',
          chatId: 'chat-console',
          kind: 'agent',
          category: 'response',
          status: 'done',
          title: 'Completed the verified task',
          ts: 8_000,
          startedAt: 8_000,
          endedAt: 8_000,
        },
      ],
      sessionEvidence: {
        status: 'completed',
        currentOperation: 'Complete',
        startedAt: 1_000,
        endedAt: 8_000,
      },
    });

    expect(screen.queryByRole('button', { name: /show activity details/i })).toBeNull();
  });

  it('does not apply an older run duration to a later user turn', () => {
    renderConsole({
      chatId: 'chat-console',
      messages: [
        message('user-old', 'user', 1_000, [{ kind: 'text', text: 'Older request.' }]),
        message('assistant-old', 'assistant', 8_000, [{ kind: 'text', text: 'Older answer.' }]),
        message('user-new', 'user', 10_000, [{ kind: 'text', text: 'New request.' }]),
        message('assistant-new', 'assistant', 10_000, [{ kind: 'text', text: 'New answer.' }]),
      ],
      activity: [
        {
          id: 'new-turn-one-timestamp',
          chatId: 'chat-console',
          kind: 'agent',
          category: 'response',
          status: 'done',
          title: 'Completed the new response',
          ts: 10_000,
          startedAt: 10_000,
          endedAt: 10_000,
        },
      ],
      sessionEvidence: {
        status: 'completed',
        currentOperation: 'Complete',
        startedAt: 1_000,
        endedAt: 8_000,
      },
    });

    expect(screen.queryByRole('button', { name: /show activity details/i })).toBeNull();
  });

  it('shows pre-event thinking, hands off to canonical live work, and removes it at terminal state', () => {
    const providerSecret = ['sk', 'proj', '1234567890abcdefghijklmnop'].join('-');
    const baseActivity: ChatActivityEvent = {
      id: 'phase',
      chatId: 'chat-console',
      kind: 'agent',
      category: 'thinking',
      status: 'pending',
      title: 'Working',
      detail: `Inspecting package.json; token ${providerSecret}`,
      ts: 10,
    };
    const rendered = renderConsole({
      chatId: 'chat-console',
      messages: [message('user-live', 'user', 5, [{ kind: 'text', text: 'Read the project.' }])],
      activity: [],
      compact: true,
      sessionEvidence: { status: 'running', currentOperation: 'Working' },
    });

    const prompt = screen.getByText('Read the project.').closest('.agentic-prompt-band');
    let liveStatus = rendered.container.querySelector('[data-live-turn-status]');
    expect(liveStatus?.textContent).toContain('Jarvis is thinking');
    expect(
      liveStatus?.querySelector('[data-agent-motion]')?.getAttribute('data-agent-motion'),
    ).toBe('cursor-forge');
    expect(
      Boolean(
        prompt &&
        liveStatus &&
        prompt.compareDocumentPosition(liveStatus) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(document.body.textContent).not.toContain('Reasoning');

    rendered.rerender(
      <TooltipProvider>
        <AgenticConsole
          chatId="chat-console"
          messages={[
            message('user-live', 'user', 5, [{ kind: 'text', text: 'Read the project.' }]),
          ]}
          activity={[baseActivity]}
          compact
          sessionEvidence={{ status: 'running', currentOperation: 'Working' }}
        />
      </TooltipProvider>,
    );
    liveStatus = rendered.container.querySelector('[data-live-turn-status]');
    expect(rendered.container.querySelectorAll('[data-live-turn-status]')).toHaveLength(1);
    expect(liveStatus?.textContent).toContain('Working');
    expect(liveStatus?.textContent).not.toContain('Jarvis is thinking');

    rendered.rerender(
      <TooltipProvider>
        <AgenticConsole
          chatId="chat-console"
          messages={[
            message('user-live', 'user', 5, [{ kind: 'text', text: 'Read the project.' }]),
          ]}
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
    expect(rendered.container.querySelector('[data-live-turn-status]')?.textContent).toContain(
      'Working',
    );
    expect(rendered.container.querySelector('[data-live-turn-status]')?.textContent).toContain(
      'Inspecting package.json',
    );
    expect(rendered.container.querySelector('[data-live-turn-status]')?.textContent).not.toContain(
      providerSecret,
    );
    expect(
      rendered.container
        .querySelector('[data-live-turn-status] [data-agent-motion]')
        ?.getAttribute('data-agent-motion'),
    ).toBe('glyph-current');

    rendered.rerender(
      <TooltipProvider>
        <AgenticConsole
          chatId="chat-console"
          messages={[
            message('user-live', 'user', 5, [{ kind: 'text', text: 'Read the project.' }]),
          ]}
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
    expect(rendered.container.querySelector('[data-live-turn-status]')).toBeNull();
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

    expect(screen.getByRole('button', { name: 'Thinking' })).toBeTruthy();
    expect(rendered.container.querySelector('[data-agent-motion]')).toBeNull();
  });

  it('keeps historical tool evidence private without inventing current receipt motion', () => {
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
      screen.getByRole('button', { name: 'Thinking' }).closest('section')?.querySelector('[data-agent-motion]'),
    ).toBeNull();
    expect(screen.getByRole('button', { name: /show activity details/i })).toBeTruthy();
    expect(document.body.textContent).not.toContain('npm test');
    expect(rendered.container.querySelectorAll('[data-agent-motion]')).toHaveLength(0);
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

  it('places the authoritative progress control between Jarvis status and model metrics', () => {
    const messages = [
      message('user', 'user', 10, [{ kind: 'text', text: 'Follow the milestone list.' }]),
    ];
    const rendered = renderConsole({
      chatId: 'chat-console',
      messages,
      activity: [],
      sessionEvidence: {
        status: 'running',
        currentOperation: 'Jarvis is running',
        model: 'opencode-go/deepseek-v4-flash-vision-exp',
      },
      headerProgress: <div data-testid="header-progress">Milestone progress</div>,
    });

    const header = rendered.container.querySelector('[data-testid="jarvis-session-panel"]');
    const status = screen.getByLabelText('Session status').closest('.agentic-session__identity');
    const progress = screen.getByTestId('header-progress');
    const metrics = screen
      .getByLabelText('Open session details')
      .closest('.agentic-session__metrics-row');

    expect(header).not.toBeNull();
    expect(header?.contains(progress)).toBe(true);
    expect(status?.nextElementSibling).toBe(progress.parentElement);
    expect(progress.parentElement?.nextElementSibling).toBe(metrics);
  });

  it('does not reserve a header progress slot when the checklist has no evidence', () => {
    const messages = [message('user', 'user', 10, [{ kind: 'text', text: 'Say hello.' }])];
    const rendered = renderConsole({
      chatId: 'chat-console',
      messages,
      activity: [],
      headerProgress: (
        <AgentChecklistBar run={undefined} events={[]} messages={messages} embedded />
      ),
    });

    const header = rendered.container.querySelector('[data-testid="jarvis-session-panel"]');
    expect(header?.querySelector('.agentic-session__progress')).toBeNull();
    expect(header?.hasAttribute('data-has-progress')).toBe(false);
    expect(screen.queryByRole('progressbar', { name: 'Agent checklist' })).toBeNull();
  });

  it('keeps raw tool payloads private and expands the safe ledger explicitly', () => {
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
    expect(document.body.textContent).not.toContain('README.md');
    expect(document.body.textContent).not.toContain('tool output');
    fireEvent.click(screen.getByRole('button', { name: /show activity details/i }));
    expect(screen.getByText('Read file')).toBeTruthy();
    expect(screen.getByText('README.md')).toBeTruthy();
    expect(document.body.textContent).not.toContain('tool output');
  });

  it('renders one authoritative ledger for a usage-bearing legacy assistant response', () => {
    const rendered = renderConsole({
      chatId: 'chat-console',
      messages: [
        message('user', 'user', 0, [{ kind: 'text', text: 'Refine the fixture.' }]),
        message(
          'assistant',
          'assistant',
          1,
          [
            { kind: 'text', text: 'Refinement complete.' },
            {
              kind: 'jarvis_source_ref',
              source: {
                id: 'source-context',
                kind: 'context_node',
                label: 'Project context map',
                trust: 'app_verified',
                sensitivity: 'private',
              },
            },
          ],
          {
            input_tokens: 247,
            output_tokens: 47,
            model: 'opencode-go/deepseek-v4-flash-vision-exp',
          },
        ),
      ],
      activity: [],
    });

    expect(rendered.container.querySelectorAll('[data-assistant-activity-ledger]')).toHaveLength(1);
    expect(screen.getAllByText(/I completed 0 recorded actions/)).toHaveLength(1);
  });

  it('omits a usage-only legacy ledger when the turn already owns tool evidence', () => {
    const usageOnly = message('final', 'assistant', 2, [{ kind: 'text', text: 'Complete.' }], {
      input_tokens: 344,
      output_tokens: 127,
      model: 'opencode-go/deepseek-v4-flash-vision-exp',
    });
    const withToolEvidence = message('action', 'assistant', 1, [
      { kind: 'tool_call', call_id: 'edit-1', tool: 'files.edit', args: {} },
      { kind: 'tool_result', call_id: 'edit-1', result: { ok: true } },
    ]);

    expect(shouldRenderInlineLegacyLedger(usageOnly, true)).toBe(false);
    expect(shouldRenderInlineLegacyLedger(withToolEvidence, true)).toBe(true);
    expect(shouldRenderInlineLegacyLedger(usageOnly, false)).toBe(true);
  });

  it('renders one ledger per user turn when a tool response is followed by finalization prose', () => {
    const rendered = renderConsole({
      chatId: 'chat-console',
      messages: [
        message('user-1', 'user', 1, [{ kind: 'text', text: 'Read the file.' }]),
        message('tool-1', 'assistant', 2, [
          { kind: 'text', text: 'I am reading the requested file.' },
          { kind: 'tool_call', call_id: 'read-1', tool: 'files.read', args: {} },
          { kind: 'tool_result', call_id: 'read-1', result: { ok: true } },
        ]),
        message(
          'final-1',
          'assistant',
          3,
          [
            { kind: 'text', text: 'The approved read completed successfully.' },
            {
              kind: 'jarvis_source_ref',
              source: {
                id: 'context-1',
                kind: 'context_node',
                label: 'Project context map',
                trust: 'app_verified',
                sensitivity: 'private',
              },
            },
          ],
          { input_tokens: 10, output_tokens: 5 },
        ),
        message('user-2', 'user', 4, [{ kind: 'text', text: 'Edit the file.' }]),
        message('tool-2', 'assistant', 5, [
          { kind: 'text', text: 'I am applying the requested edit.' },
          { kind: 'tool_call', call_id: 'edit-1', tool: 'files.edit', args: {} },
          { kind: 'tool_result', call_id: 'edit-1', result: { ok: true } },
        ]),
        message(
          'final-2',
          'assistant',
          6,
          [
            { kind: 'text', text: 'The approved edit completed successfully.' },
            {
              kind: 'jarvis_source_ref',
              source: {
                id: 'context-2',
                kind: 'context_node',
                label: 'Project context map',
                trust: 'app_verified',
                sensitivity: 'private',
              },
            },
          ],
          { input_tokens: 12, output_tokens: 6 },
        ),
      ],
      activity: [],
    });

    expect(rendered.container.querySelectorAll('[data-assistant-activity-ledger]')).toHaveLength(2);
  });

  it('keeps one native checkpoint ledger chronologically between its assistant text parts', () => {
    const rendered = renderConsole({
      chatId: 'chat-console',
      messages: [
        message('user-native-parts', 'user', 1, [
          { kind: 'text', text: 'MAKE ME A FULL HTML GAME OKAY' },
        ]),
        message('assistant-native-parts', 'assistant', 2, [
          { kind: 'text', text: 'I built the game shell and core loop.' },
          {
            kind: 'tool_call',
            call_id: 'write-game',
            tool: 'files.write',
            args: { path: 'index.html' },
          },
          {
            kind: 'tool_result',
            call_id: 'write-game',
            result: { status: 'completed' },
          },
          { kind: 'text', text: 'The complete HTML game is ready and verified.' },
        ]),
      ],
      activity: [],
      sessionEvidence: { status: 'completed' },
    });

    const firstCheckpoint = screen.getByText('I built the game shell and core loop.');
    const finalCheckpoint = screen.getByText('The complete HTML game is ready and verified.');
    const ledgers = rendered.container.querySelectorAll('[data-assistant-activity-ledger]');
    expect(ledgers).toHaveLength(1);
    const ledger = ledgers[0]!;
    expect(
      firstCheckpoint.compareDocumentPosition(ledger) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(ledger.compareDocumentPosition(finalCheckpoint) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(ledger.textContent).toContain('Edited 1');
    expect(rendered.container.querySelectorAll('[data-native-assistant-checkpoint]')).toHaveLength(
      2,
    );
    expect(rendered.container.textContent).not.toContain('Final response');
    expect(rendered.container.textContent).not.toContain('Assistant');
    expect(rendered.container.textContent).not.toContain('C:\\');
  });

  it('keeps tool-first work visible without inventing a factual checkpoint', () => {
    const rendered = renderConsole({
      chatId: 'chat-console',
      messages: [
        message('user-tool-first', 'user', 1, [{ kind: 'text', text: 'Build the game.' }]),
        message(
          'assistant-tool-first',
          'assistant',
          2,
          [
            {
              kind: 'tool_call',
              call_id: 'write-game',
              tool: 'files.write',
              args: { path: 'index.html' },
            },
            { kind: 'tool_result', call_id: 'write-game', result: { status: 'completed' } },
            { kind: 'text', text: 'The complete HTML game is ready.' },
          ],
          { model: 'opencode-go/deepseek-v4-flash-vision-exp' },
        ),
      ],
      activity: [],
      sessionEvidence: { status: 'completed' },
    });

    const ledger = rendered.container.querySelector('[data-assistant-activity-ledger]');
    const finalAnswer = screen.getByText('The complete HTML game is ready.');
    expect(ledger).toBeTruthy();
    expect(
      ledger!.compareDocumentPosition(finalAnswer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(rendered.container.textContent).not.toContain('I’m updating');
    expect(rendered.container.textContent).not.toContain('I’m testing');
    expect(rendered.container.textContent).not.toContain('C:\\');
  });

  it('uses the live OpenCode session model to show a neutral tool-first checkpoint', () => {
    const rendered = renderConsole({
      chatId: 'chat-console',
      messages: [
        message('user-live-tool-first', 'user', 1, [{ kind: 'text', text: 'Build the game.' }]),
        message('assistant-live-tool-first', 'assistant', 2, [
          {
            kind: 'tool_call',
            call_id: 'opencode-tool-1',
            tool: 'read',
            args: { path: 'game.js' },
          },
        ]),
      ],
      activity: [],
      sessionEvidence: {
        status: 'running',
        model: 'opencode-go/deepseek-v4-flash-vision-exp',
      },
    });

    expect(rendered.container.querySelectorAll('[data-native-assistant-checkpoint]')).toHaveLength(
      1,
    );
    expect(screen.getByText('Working…')).toBeTruthy();
    expect(rendered.container.querySelectorAll('[data-assistant-activity-ledger]')).toHaveLength(1);
    expect(rendered.container.textContent).not.toMatch(/updated|tested|verified/iu);
  });

  it('does not claim native OpenCode chronology for an unrelated DeepSeek tool message', () => {
    const rendered = renderConsole({
      chatId: 'chat-console',
      messages: [
        message('user-unrelated-deepseek', 'user', 1, [{ kind: 'text', text: 'Inspect it.' }]),
        message(
          'assistant-unrelated-deepseek',
          'assistant',
          2,
          [
            { kind: 'text', text: 'Inspection complete.' },
            { kind: 'tool_call', call_id: 'other-tool', tool: 'read', args: {} },
            { kind: 'tool_result', call_id: 'other-tool', result: { status: 'completed' } },
          ],
          { model: 'deepseek-v4' },
        ),
      ],
      activity: [],
      sessionEvidence: { status: 'completed' },
    });

    expect(rendered.container.querySelector('[data-native-assistant-checkpoint]')).toBeNull();
    expect(screen.getByText('Inspection complete.')).toBeTruthy();
  });

  it('renders five native public checkpoints and four scoped disclosures without private reasoning', () => {
    const rendered = renderConsole({
      chatId: 'chat-console',
      messages: [
        message('user-five-checkpoints', 'user', 1, [
          { kind: 'text', text: 'Build the full game.' },
        ]),
        message(
          'assistant-five-checkpoints',
          'assistant',
          2,
          [
            { kind: 'text', text: 'I’m inspecting the current project.' },
            { kind: 'reasoning', text: 'PRIVATE internal narration must never render.' },
            {
              kind: 'jarvis_source_ref',
              source: {
                id: 'private-source',
                kind: 'context_node',
                label: 'PRIVATE project source',
                trust: 'app_verified',
                sensitivity: 'private',
              },
            },
            {
              kind: 'tool_call',
              call_id: 'read-game',
              tool: 'read',
              args: { path: 'C:\\private\\game.js' },
            },
            { kind: 'tool_result', call_id: 'read-game', result: { status: 'completed' } },
            { kind: 'text', text: 'I found the existing game loop.' },
            {
              kind: 'tool_call',
              call_id: 'edit-player',
              tool: 'edit',
              args: { path: 'C:\\private\\player.js' },
            },
            { kind: 'tool_result', call_id: 'edit-player', result: { status: 'completed' } },
            { kind: 'text', text: 'I’ve implemented the player systems.' },
            {
              kind: 'tool_call',
              call_id: 'run-test',
              tool: 'bash',
              args: { command: 'private command' },
            },
            { kind: 'tool_result', call_id: 'run-test', result: { status: 'completed' } },
            { kind: 'text', text: 'I’m checking the finished game.' },
            { kind: 'tool_call', call_id: 'verify-game', tool: 'verify.test', args: {} },
            { kind: 'tool_result', call_id: 'verify-game', result: { status: 'completed' } },
            { kind: 'text', text: 'The full game is ready.' },
          ],
          { model: 'opencode-go/deepseek-v4-flash-vision-exp' },
        ),
      ],
      activity: [],
      sessionEvidence: { status: 'completed' },
    });

    expect(rendered.container.querySelectorAll('[data-native-assistant-checkpoint]')).toHaveLength(
      5,
    );
    expect(rendered.container.querySelectorAll('[data-assistant-activity-ledger]')).toHaveLength(4);
    expect(screen.getAllByRole('button', { name: /show activity details/i })).toHaveLength(4);
    expect(rendered.container.textContent).not.toMatch(
      /PRIVATE internal|PRIVATE project|Final response|Assistant|C:\\private|private command/iu,
    );

    fireEvent.click(screen.getAllByRole('button', { name: /show activity details/i })[0]!);
    expect(screen.getByText('Read game.js')).toBeTruthy();
    expect(rendered.container.querySelector('.assistant-activity-ledger__metrics')).toBeNull();
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
