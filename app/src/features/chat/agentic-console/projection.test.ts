import { describe, expect, it } from 'vitest';
import type { ChatActivityEvent } from '../activity/types';
import type { Message } from '@/types';
import {
  MAX_DIFF_LINES,
  MAX_OUTPUT_CHARS,
  formatUnifiedDiffLines,
  projectAgenticTranscript,
  sanitizeConsoleText,
  summarizeAgenticSession,
  windowTranscriptBlocks,
} from './projection';

function message(
  id: string,
  role: Message['role'],
  createdAt: number,
  parts: Message['parts'],
  usage?: Message['usage'],
): Message {
  return {
    id: id as Message['id'],
    chat_id: 'chat-1' as Message['chat_id'],
    role,
    parts,
    created_at: createdAt,
    updated_at: createdAt,
    usage,
  };
}

describe('projectAgenticTranscript', () => {
  it('projects prompt, reasoning, paired tool call/result, and final response in stable order', () => {
    const messages = [
      message('m1', 'user', 10, [{ kind: 'text', text: 'Inspect the repository' }]),
      message('m2', 'assistant', 20, [
        { kind: 'reasoning', text: 'I will inspect the bounded paths.' },
        {
          kind: 'tool_call',
          tool: 'shell',
          args: { command: 'git status --short', cwd: 'C:\\repo' },
          call_id: 'call-1',
        },
        { kind: 'tool_result', call_id: 'call-1', result: ' M app.tsx' },
        { kind: 'text', text: 'The repository has one modified file.' },
      ]),
    ];

    const blocks = projectAgenticTranscript(messages, []);

    expect(blocks.map((block) => block.kind)).toEqual(['prompt', 'reasoning', 'command', 'answer']);
    expect(blocks[2]).toMatchObject({
      kind: 'command',
      command: 'git status --short',
      cwd: 'C:\\repo',
      output: ' M app.tsx',
    });
    expect(blocks[3]).toMatchObject({
      kind: 'answer',
      text: 'The repository has one modified file.',
    });
  });

  it('renders diffs only from canonical activity that contains a real diff payload', () => {
    const events: ChatActivityEvent[] = [
      {
        id: 'no-patch',
        chatId: 'chat-1',
        kind: 'file',
        status: 'done',
        title: 'Touched app.tsx',
        filePath: 'app.tsx',
        addedLines: 99,
        removedLines: 3,
        ts: 10,
      },
      {
        id: 'real-patch',
        chatId: 'chat-1',
        kind: 'diff',
        status: 'done',
        title: 'Edited app.tsx',
        filePath: 'app.tsx',
        addedLines: 1,
        removedLines: 1,
        diff: '--- a/app.tsx\n+++ b/app.tsx\n-old\n+new',
        ts: 11,
      },
    ];

    const blocks = projectAgenticTranscript([], events);

    expect(blocks.filter((block) => block.kind === 'diff')).toHaveLength(1);
    expect(blocks.find((block) => block.kind === 'diff')).toMatchObject({
      sourceId: 'activity:real-patch',
      filePath: 'app.tsx',
      diff: '--- a/app.tsx\n+++ b/app.tsx\n-old\n+new',
    });
    expect(blocks.find((block) => block.sourceId === 'activity:no-patch')?.kind).toBe('activity');
  });

  it('deduplicates canonical activity by id and falls back for interactive structured messages', () => {
    const approval = message('approval', 'assistant', 4, [
      {
        kind: 'action_proposal',
        call_id: 'proposal-1',
        action_id: 'nav.goto',
        params: { route: 'files' },
        status: 'pending',
      },
    ]);
    const event: ChatActivityEvent = {
      id: 'same',
      chatId: 'chat-1',
      kind: 'tool',
      status: 'running',
      title: 'Running test',
      ts: 5,
    };

    const blocks = projectAgenticTranscript([approval], [event, { ...event, title: 'Duplicate' }]);

    expect(blocks.filter((block) => block.sourceId === 'activity:same')).toHaveLength(1);
    expect(blocks.find((block) => block.sourceId === 'message:approval')).toMatchObject({
      kind: 'legacy',
      message: approval,
    });
  });

  it('extracts truthful exit and duration evidence from structured command results', () => {
    const messages = [
      message('command', 'assistant', 1, [
        {
          kind: 'tool_call',
          tool: 'terminal.exec',
          args: { command: 'npm test', cwd: 'C:\\repo' },
          call_id: 'command-1',
        },
        {
          kind: 'tool_result',
          call_id: 'command-1',
          result: { stdout: '12 tests passed', exit_code: 0, duration_ms: 321 },
        },
      ]),
    ];

    expect(projectAgenticTranscript(messages, [])[0]).toMatchObject({
      kind: 'command',
      output: '12 tests passed',
      exitCode: 0,
      durationMs: 321,
    });
  });

  it('bounds unsafe terminal output and diff lines without mutating canonical inputs', () => {
    const hostile = `before\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007\u001b[31mred\u001b[0m${'x'.repeat(
      MAX_OUTPUT_CHARS + 100,
    )}`;
    const clean = sanitizeConsoleText(hostile, MAX_OUTPUT_CHARS);

    expect(clean).not.toContain('\u001b');
    expect(clean.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 32);
    expect(hostile).toContain('\u001b');

    const diff = Array.from({ length: MAX_DIFF_LINES + 20 }, (_, index) => `+line ${index}`).join(
      '\n',
    );
    const blocks = projectAgenticTranscript(
      [],
      [
        {
          id: 'large-diff',
          chatId: 'chat-1',
          kind: 'diff',
          status: 'done',
          title: 'Large patch',
          diff,
          ts: 1,
        },
      ],
    );
    const projected = blocks[0];
    expect(projected?.kind).toBe('diff');
    if (projected?.kind !== 'diff') throw new Error('Expected a diff block.');
    expect(projected.diff.split('\n').length).toBeLessThanOrEqual(MAX_DIFF_LINES + 1);
    expect(diff.split('\n')).toHaveLength(MAX_DIFF_LINES + 20);
  });

  it('redacts detected secrets from every visible console preview', () => {
    const secret = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
    const clean = sanitizeConsoleText(`Authorization: Bearer ${secret}`);

    expect(clean).not.toContain(secret);
    expect(clean).toContain('[redacted:');
  });

  it('derives truthful old and new gutters from unified diff hunks', () => {
    expect(
      formatUnifiedDiffLines('@@ -10,2 +10,3 @@\n unchanged\n-removed\n+added\n+another'),
    ).toEqual([
      { text: '@@ -10,2 +10,3 @@', kind: 'meta', oldLine: undefined, newLine: undefined },
      { text: ' unchanged', kind: 'context', oldLine: 10, newLine: 10 },
      { text: '-removed', kind: 'remove', oldLine: 11, newLine: undefined },
      { text: '+added', kind: 'add', oldLine: undefined, newLine: 11 },
      { text: '+another', kind: 'add', oldLine: undefined, newLine: 12 },
    ]);
  });
});

describe('agentic transcript session and viewport', () => {
  it('summarizes only known evidence and uses dashes for unknown values', () => {
    const messages = [
      message('a', 'assistant', 100, [{ kind: 'text', text: 'Done.' }], {
        input_tokens: 40,
        output_tokens: 10,
        model: 'verified-model',
      }),
    ];
    const activity: ChatActivityEvent[] = [
      {
        id: 'd',
        chatId: 'chat-1',
        kind: 'diff',
        status: 'done',
        title: 'Edit',
        filePath: 'src/a.ts',
        addedLines: 3,
        removedLines: 1,
        ts: 90,
        endedAt: 120,
      },
    ];

    expect(summarizeAgenticSession(messages, activity)).toMatchObject({
      status: 'done',
      fileCount: 1,
      addedLines: 3,
      removedLines: 1,
      tokenCount: 50,
      model: 'verified-model',
      context: '—',
    });
  });

  it('mounts the newest 400 blocks and pages older blocks in groups of 100', () => {
    const blocks = Array.from({ length: 650 }, (_, index) => ({
      id: `b-${index}`,
      sourceId: `s-${index}`,
      kind: 'activity' as const,
      ts: index,
      status: 'done' as const,
      activityKind: 'tool' as const,
      title: `Block ${index}`,
    }));

    const initial = windowTranscriptBlocks(blocks, 400);
    expect(initial.visible).toHaveLength(400);
    expect(initial.visible[0]?.id).toBe('b-250');
    expect(initial.remaining).toBe(250);

    const next = windowTranscriptBlocks(blocks, 500);
    expect(next.visible).toHaveLength(500);
    expect(next.visible[0]?.id).toBe('b-150');
    expect(next.remaining).toBe(150);
  });

  it('does not mislabel a cancelled run or a user-only prompt as completed', () => {
    expect(
      summarizeAgenticSession(
        [],
        [
          {
            id: 'cancelled',
            chatId: 'chat-1',
            kind: 'tool',
            status: 'cancelled',
            title: 'Cancelled by user',
            ts: 1,
          },
        ],
      ),
    ).toMatchObject({ status: 'cancelled', currentOperation: 'Cancelled by user' });

    expect(
      summarizeAgenticSession(
        [message('prompt-only', 'user', 1, [{ kind: 'text', text: 'Start a task' }])],
        [],
      ),
    ).toMatchObject({ status: 'idle', currentOperation: 'Ready' });
  });
});
