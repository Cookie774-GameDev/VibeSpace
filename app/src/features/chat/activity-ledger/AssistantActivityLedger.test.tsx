import * as React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import type { ChatActivityEvent } from '../activity/types';
import { AssistantActivityLedger, DETAIL_PAGE_SIZE } from './AssistantActivityLedger';

function assistant(parts: Message['parts'], usage?: Message['usage']): Message {
  return {
    id: 'message-ledger-ui' as Message['id'],
    chat_id: 'chat-ledger-ui' as Message['chat_id'],
    role: 'assistant',
    parts,
    created_at: 100,
    updated_at: 1_100,
    ...(usage ? { usage } : {}),
  };
}

describe('AssistantActivityLedger', () => {
  it('uses the owning cancelled response status even when recorded commands already settled', () => {
    render(
      <AssistantActivityLedger
        responseStatus="cancelled"
        message={assistant([
          { kind: 'tool_call', call_id: 'finished-before-pause', tool: 'command', args: {} },
          {
            kind: 'tool_result',
            call_id: 'finished-before-pause',
            result: { status: 'completed' },
          },
        ])}
      />,
    );
    expect(screen.getByText(/before this response was cancelled/)).toBeTruthy();
    expect(screen.queryByText(/I completed 1 recorded action/)).toBeNull();
  });
  it('points the disclosure chevron right when collapsed and up when expanded', () => {
    const stylesheet = readFileSync(
      resolve(process.cwd(), 'src/features/chat/activity-ledger/activity-ledger.css'),
      'utf8',
    );

    expect(stylesheet).toMatch(
      /\.assistant-activity-ledger__chevron\s*\{[^}]*transform:\s*rotate\(-90deg\)/s,
    );
    expect(stylesheet).toMatch(
      /\.assistant-activity-ledger__chevron\.is-open\s*\{[^}]*transform:\s*rotate\(180deg\)/s,
    );
  });

  it('renders one compact disclosure, exact usage, and a privacy-safe command receipt', () => {
    render(
      <AssistantActivityLedger
        message={assistant(
          [
            {
              kind: 'tool_call',
              call_id: 'call-1',
              tool: 'terminal.exec',
              args: { command: 'echo secret-command' },
            },
            {
              kind: 'tool_result',
              call_id: 'call-1',
              result: { stdout: 'secret-output', exitCode: 0 },
            },
          ],
          { input_tokens: 100, output_tokens: 25 },
        )}
      />,
    );

    expect(screen.getAllByRole('button', { name: /activity details/i })).toHaveLength(1);
    const disclosure = screen.getByRole('button', { name: /show activity details/i });
    const describedBy = disclosure.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain('Ran 1 command');
    expect(document.getElementById(describedBy!)?.textContent).toContain('In 100');
    expect(screen.getByText('Ran 1 command')).toBeTruthy();
    expect(screen.getByText('In 100').getAttribute('title')).toBe('Exact response metadata');
    expect(screen.getByText('Out 25').getAttribute('title')).toBe('Exact response metadata');
    expect(
      screen.getByText(
        'I completed 1 recorded action: ran 1 command. No next action is recorded for this response.',
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain('secret-command');
    expect(document.body.textContent).not.toContain('secret-output');

    fireEvent.click(screen.getByRole('button', { name: /activity details/i }));
    expect(screen.getByText('Ran command')).toBeTruthy();
    expect(document.body.textContent).not.toContain('secret-command');
  });

  it('reveals exact sanitized command, tool, and file details only after expansion', () => {
    const providerSecret = ['sk', 'proj', '1234567890abcdefghijklmnop'].join('-');
    render(
      <AssistantActivityLedger
        message={assistant([
          {
            kind: 'tool_call',
            call_id: 'command-public',
            tool: 'terminal.exec',
            args: { command: 'npm run typecheck' },
          },
          { kind: 'tool_result', call_id: 'command-public', result: { exitCode: 0 } },
          {
            kind: 'tool_call',
            call_id: 'read-public',
            tool: 'read_file',
            args: { path: 'C:\\private\\src\\PublicActivity.tsx' },
          },
          { kind: 'tool_result', call_id: 'read-public', result: { exitCode: 0 } },
          {
            kind: 'tool_call',
            call_id: 'tool-public',
            tool: 'mcp.cloudflare.deploy_worker',
            args: { token: providerSecret },
          },
          { kind: 'tool_result', call_id: 'tool-public', result: { status: 'completed' } },
        ])}
      />,
    );

    expect(document.body.textContent).not.toContain('npm run typecheck');
    expect(document.body.textContent).not.toContain('PublicActivity.tsx');
    screen
      .getAllByRole('button', { name: /show activity details/i })
      .forEach((disclosure) => fireEvent.click(disclosure));
    expect(screen.getByText('npm run typecheck')).toBeTruthy();
    expect(screen.getByText('PublicActivity.tsx')).toBeTruthy();
    expect(screen.getByText('mcp.cloudflare.deploy_worker')).toBeTruthy();
    expect(document.body.textContent).not.toContain('C:\\private');
    expect(document.body.textContent).not.toContain(providerSecret);
  });

  it('shows a truthful two-sentence live phase summary from the current receipt', () => {
    render(
      <AssistantActivityLedger
        active
        message={assistant([
          {
            kind: 'tool_call',
            call_id: 'read-live',
            tool: 'read',
            args: { path: 'Composer.tsx' },
          },
        ])}
      />,
    );

    expect(
      screen.getByText('I’m reading Composer.tsx now. No next action is recorded yet.'),
    ).toBeTruthy();
  });

  it('does not call an active response complete when no current receipt is recorded', () => {
    render(
      <AssistantActivityLedger
        active
        message={assistant([
          {
            kind: 'tool_call',
            call_id: 'check-done',
            tool: 'verify',
            args: {},
          },
          { kind: 'tool_result', call_id: 'check-done', result: { status: 'completed' } },
        ])}
      />,
    );

    expect(
      screen.getByText(
        'I recorded 1 action in this active response. No current or next action is recorded yet.',
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain('I completed 1 recorded action');
  });

  it('shows the terminal duration and total actions in the continuous-response summary', () => {
    render(
      <AssistantActivityLedger
        message={assistant([
          {
            kind: 'tool_call',
            call_id: 'read-one',
            tool: 'read_file',
            args: { path: 'C:\\private\\src\\ReviewPanel.tsx' },
          },
          { kind: 'tool_result', call_id: 'read-one', result: { exitCode: 0 } },
        ])}
        correlatedEvents={[
          {
            id: 'search-one',
            chatId: 'chat-ledger-ui',
            kind: 'url',
            status: 'done',
            title: 'Opaque search activity',
            ts: 100,
            startedAt: 100,
            endedAt: 61_100,
          },
        ]}
      />,
    );

    const disclosure = screen.getByRole('button', {
      name: 'Show activity details Worked for 1m 1s · 2 actions',
    });
    expect(disclosure).toBeTruthy();
    fireEvent.click(disclosure);
    expect(screen.getByText('ReviewPanel.tsx')).toBeTruthy();
    expect(document.body.textContent).not.toContain('C:\\private');
  });

  it('persists ordered context, tool, and verification phases with truthful next-recorded summaries', () => {
    render(
      <AssistantActivityLedger
        message={assistant([
          {
            kind: 'tool_call',
            call_id: 'read-1',
            tool: 'read_file',
            args: { path: 'ChatThread.tsx' },
          },
          { kind: 'tool_result', call_id: 'read-1', result: { exitCode: 0 } },
          { kind: 'tool_call', call_id: 'search-1', tool: 'search', args: {} },
          { kind: 'tool_result', call_id: 'search-1', result: { exitCode: 0 } },
          { kind: 'tool_call', call_id: 'command-1', tool: 'terminal.exec', args: {} },
          { kind: 'tool_result', call_id: 'command-1', result: { exitCode: 0 } },
          {
            kind: 'tool_call',
            call_id: 'edit-1',
            tool: 'apply_patch',
            args: { path: 'ChatThread.tsx' },
          },
          { kind: 'tool_result', call_id: 'edit-1', result: { exitCode: 0 } },
          { kind: 'tool_call', call_id: 'check-1', tool: 'verify.test', args: {} },
          { kind: 'tool_result', call_id: 'check-1', result: { exitCode: 0 } },
        ])}
      />,
    );

    expect(screen.getAllByRole('button', { name: /show activity details/i })).toHaveLength(3);
    expect(
      screen.getByText(
        'I read 1 file and completed 1 search to gather context. Next, I used the recorded project tools.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'I ran 1 command and edited 1 file. Next, I verified the recorded project check.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('I verified 1 check. No next action is recorded for this response.'),
    ).toBeTruthy();
  });

  it('renders one warm OpenCode chronology disclosure with left-only natural receipt rows', () => {
    const rendered = render(
      <AssistantActivityLedger
        presentation="opencode-chronology"
        message={assistant([
          {
            kind: 'tool_call',
            call_id: 'read-chronology',
            tool: 'read_file',
            args: { path: 'C:\\private\\game.js' },
          },
          { kind: 'tool_result', call_id: 'read-chronology', result: { status: 'completed' } },
          {
            kind: 'tool_call',
            call_id: 'edit-chronology',
            tool: 'apply_patch',
            args: { path: 'C:\\private\\player.js' },
          },
          { kind: 'tool_result', call_id: 'edit-chronology', result: { status: 'completed' } },
          { kind: 'tool_call', call_id: 'check-chronology', tool: 'verify.test', args: {} },
          { kind: 'tool_result', call_id: 'check-chronology', result: { status: 'completed' } },
        ])}
      />,
    );

    expect(screen.getAllByRole('button', { name: /show activity details/i })).toHaveLength(1);
    expect(screen.getByText('3 actions')).toBeTruthy();
    expect(
      rendered.container.querySelector('.assistant-activity-ledger__phase-summary'),
    ).toBeNull();
    expect(rendered.container.querySelector('.assistant-activity-ledger__metrics')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /show activity details/i }));
    expect(screen.getByText('Read game.js')).toBeTruthy();
    expect(screen.getByText('Edited player.js')).toBeTruthy();
    expect(screen.getByText('Verified check')).toBeTruthy();
    expect(rendered.container.querySelector('.assistant-activity-ledger__duration')).toBeNull();
    expect(rendered.container.querySelector('.assistant-activity-ledger__status')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Read file|C:\\private/iu);
  });

  it('keeps OpenCode chronology failures truthful without success language', () => {
    render(
      <AssistantActivityLedger
        presentation="opencode-chronology"
        message={assistant([
          {
            kind: 'tool_call',
            call_id: 'check-failed',
            tool: 'verify.test',
            args: {},
          },
          { kind: 'tool_result', call_id: 'check-failed', error: 'private failure' },
        ])}
      />,
    );

    expect(screen.getByText('1 action · failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /show activity details/i }));
    expect(screen.getByText('Failed: verifying check')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Verified');
    expect(document.body.textContent).not.toContain('private failure');
  });

  it('does not fabricate an action ledger from a generic persisted lifecycle event', () => {
    const rendered = render(
      <AssistantActivityLedger
        authoritativeDurationMs={7_000}
        message={{ ...assistant([{ kind: 'text', text: 'Done.' }]), updated_at: 100 }}
        correlatedEvents={[
          {
            id: 'terminal-same-time',
            chatId: 'chat-ledger-ui',
            kind: 'tool',
            status: 'done',
            title: 'Completed activity',
            ts: 100,
          },
        ]}
      />,
    );

    expect(rendered.container.querySelector('[data-assistant-activity-ledger="true"]')).toBeNull();
  });

  it('does not render an empty activity surface before a truthful receipt exists', () => {
    const rendered = render(
      <AssistantActivityLedger
        active
        message={assistant([])}
        correlatedEvents={[
          {
            id: 'completed-read',
            chatId: 'chat-ledger-ui',
            kind: 'agent',
            category: 'response',
            status: 'done',
            title: 'Opaque provider lifecycle activity',
            ts: 100,
            startedAt: 100,
            endedAt: 1_100,
          },
        ]}
      />,
    );

    expect(rendered.container.querySelector('[data-assistant-activity-ledger="true"]')).toBeNull();
  });

  it('expands into one compact ordered receipt transcript and bounds mounted rows', () => {
    const events: ChatActivityEvent[] = Array.from(
      { length: DETAIL_PAGE_SIZE + 12 },
      (_, index) => ({
        id: `read-${index}`,
        chatId: 'chat-ledger-ui',
        kind: 'tool',
        category: 'file',
        status: 'done',
        title: 'Read file',
        filePath: `file-${index}.ts`,
        ts: index,
      }),
    );
    render(<AssistantActivityLedger message={assistant([])} correlatedEvents={events} />);
    fireEvent.click(screen.getByRole('button', { name: /activity details/i }));

    expect(screen.getAllByTestId('activity-ledger-receipt')).toHaveLength(DETAIL_PAGE_SIZE);
    expect(screen.getByRole('list', { name: 'Activity receipts' })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(DETAIL_PAGE_SIZE);
    expect(screen.getByRole('button', { name: /show 12 more/i })).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Activity categories' })).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.getByRole('region', { name: 'Assistant activity details' }).style.height).toBe(
      '',
    );
  });

  it('shows estimated and unavailable usage without mixing provenance', () => {
    render(
      <AssistantActivityLedger
        message={assistant([
          {
            kind: 'token_optimization_receipt',
            receipt: {
              mode: 'safe' as never,
              providerId: 'opencode',
              modelId: 'm',
              modelChanged: false,
              tokenizerSource: 'conservative_estimate',
              outputTokenLimit: 100,
              estimatedInputTokensBefore: 20,
              estimatedInputTokensAfter: 15,
              estimatedTokensSaved: 5,
              selectedCount: 1,
              excludedCount: 0,
              fitsContext: true,
              overflowTokens: 0,
              inclusions: [],
              exclusions: [],
            },
          },
        ])}
      />,
    );
    expect(screen.getByText('In ≈15').getAttribute('title')).toBe('Estimated locally');
    fireEvent.click(screen.getByRole('button', { name: /activity details/i }));
    expect(screen.getByText('Output usage unavailable')).toBeTruthy();
  });

  it.each([
    ['mail', 'mail-send'],
    ['ship', 'ship-launch'],
  ] as const)(
    'renders %s motion from the correlated structured intent',
    (semanticIntent, motion) => {
      render(
        <AssistantActivityLedger
          message={assistant([
            {
              kind: 'tool_call',
              call_id: `structured-${semanticIntent}`,
              tool: 'terminal.exec',
              args: { command: 'private' },
            },
            {
              kind: 'tool_result',
              call_id: `structured-${semanticIntent}`,
              result: { exitCode: 0 },
            },
          ])}
          active
          correlatedEvents={[
            {
              id: `structured-${semanticIntent}`,
              chatId: 'chat-ledger-ui',
              kind: 'tool',
              category: 'thinking',
              semanticIntent,
              status: 'running',
              title: 'Generic tool activity',
              ts: 100,
            },
          ]}
        />,
      );

      expect(document.querySelector(`[data-agent-motion="${motion}"]`)).not.toBeNull();
    },
  );
});
