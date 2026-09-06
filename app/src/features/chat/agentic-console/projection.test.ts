import { describe, expect, it } from 'vitest';
import type { ChatActivityEvent } from '../activity/types';
import type { Message } from '@/types';
import {
  MAX_DIFF_LINES,
  MAX_OUTPUT_CHARS,
  formatUnifiedDiffLines,
  projectAgenticTranscript,
  projectAgenticTranscriptWindow,
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

  it('does not infer an older completion while the latest saved request awaits recovery status', () => {
    const messages = [message('old', 'assistant', 1, [{ kind: 'text', text: 'Earlier result' }]), message('pending', 'user', 2, [{ kind: 'text', text: 'A new request' }])];
    expect(summarizeAgenticSession(messages, [])).toMatchObject({ status: 'recovering', currentOperation: 'Checking saved request status' });
    expect(summarizeAgenticSession(messages, [], { status: 'failed' }).status).toBe('error');
    expect(summarizeAgenticSession([...messages, message('new', 'assistant', 3, [{ kind: 'text', text: 'New result' }])], []).status).toBe('done');
  });

  it('uses the provider total when cached tokens are separately reported', () => {
    expect(summarizeAgenticSession([message('total', 'assistant', 1, [], {input_tokens: 626, output_tokens: 228, total_tokens: 41814, cache_read_tokens: 40960})], []).tokenCount).toBe(41814);
  });
  it('keeps one stable Thinking block when live evidence becomes a saved multi-part answer', () => {
    const live: ChatActivityEvent[] = [{ id: 'thinking', chatId: 'chat-1', kind: 'agent', category: 'thinking', messageId: 'answer', title: 'Thinking', detail: 'First', status: 'running', ts: 1 }];
    const before = projectAgenticTranscript([], live);
    const saved = message('answer', 'assistant', 2, [{kind: 'reasoning', text: 'First'}, {kind: 'text', text: 'Checkpoint'}, {kind: 'reasoning', text: 'Second'}, {kind: 'text', text: 'Done'}]);
    const after = projectAgenticTranscript([saved], live);
    expect(before[0]).toMatchObject({kind: 'reasoning', text: 'First'});
    expect(after.filter(block => block.kind === 'reasoning')).toEqual([expect.objectContaining({id: before[0]!.id, text: 'First\n\nSecond'})]);
    expect(projectAgenticTranscriptWindow([saved], live, 2)).toMatchObject({total: 3, remaining: 1});
  });
  it('does not display a stale terminal timestamp as zero elapsed time for an active run', () => {
    expect(summarizeAgenticSession([], [], { status: 'running', startedAt: 20, endedAt: 10 }).durationMs).toBe('—');
  });
  it('keeps restored confirmed diffs and empty thinking in the virtual transcript count', () => {
    const messages = [message('edit', 'assistant', 1, [
      {kind: 'reasoning', text: ''},
      {kind: 'tool_call', tool: 'edit', call_id: 'one', args: {path: 'a.txt'}},
      {kind: 'tool_result', call_id: 'one', result: {status: 'completed', diff: '-old\n+new'}},
    ])];
    expect(projectAgenticTranscriptWindow(messages, [], 2)).toMatchObject({total: 3, remaining: 1});
  });
  it('counts persisted file changes once alongside their matching live evidence', () => {
    const messages = [message('edit', 'assistant', 1, [
      { kind: 'tool_call', tool: 'edit', call_id: 'one', args: { path: 'src/alpha.txt' } },
      { kind: 'tool_result', call_id: 'one', result: { status: 'completed', diff: '-old\n+new' } },
      { kind: 'tool_call', tool: 'read', call_id: 'two', args: { path: 'src/beta.txt' } },
    ])];
    const live: ChatActivityEvent[] = [{ id: 'one', chatId: 'chat-1', kind: 'file', messageId: 'edit', providerCallId: 'one',
      status: 'done', title: 'Edited', filePath: 'src/alpha.txt', diff: '-old\n+new',
      addedLines: 1, removedLines: 1, ts: 1 }];
    for (const events of [[], live]) {
      expect(summarizeAgenticSession(messages, events)).toMatchObject({fileCount: 2, addedLines: 1, removedLines: 1});
      expect(projectAgenticTranscriptWindow(messages, events).visible.filter(block => block.kind === 'diff')).toHaveLength(1);
    }
  });
  it('does not collapse distinct edits merely because their diff text is identical', () => {
    const messages = ['first', 'second'].map((id, index) => message(id, 'assistant', index + 1, [
      {kind: 'tool_call', tool: 'edit', call_id: 'one', args: {path: 'alpha.txt'}},
      {kind: 'tool_result', call_id: 'one', result: {status: 'completed', diff: '-old\n+new'}},
    ]));
    expect(summarizeAgenticSession(messages, [])).toMatchObject({addedLines: 2, removedLines: 2});
  });
  it('counts saved authoritative changes even when a source reference keeps the message interactive', () => {
    const saved = message('with-source', 'assistant', 1, [
      { kind: 'jarvis_source_ref', source: { id: 'source', kind: 'project_file', label: 'Context', trust: 'app_verified', sensitivity: 'restricted' } },
      { kind: 'tool_call', tool: 'edit', call_id: 'edit', args: { path: 'alpha.txt' } },
      { kind: 'tool_result', call_id: 'edit', result: { status: 'completed', diff: '-old\n+new' } },
    ]);
    expect(summarizeAgenticSession([saved], [])).toMatchObject({ fileCount: 1, addedLines: 1, removedLines: 1 });
    expect(projectAgenticTranscript([saved], [])[0]?.kind).toBe('legacy');
  });
  it('keeps unavailable usage distinct from estimates and observed zero', () => {
    expect(summarizeAgenticSession([message('u', 'assistant', 1, [], {
      input_tokens: 0, output_tokens: 0, provenance: 'unavailable',
    })], []).tokenCount).toBe('—');
    expect(summarizeAgenticSession([message('e', 'assistant', 1, [], {
      input_tokens: 10, output_tokens: 5, provenance: 'estimated',
    })], [])).toMatchObject({tokenCount: 15, tokenProvenance: 'estimated'});
  });
  it('projects persisted confirmed tool diffs with exact additions and removals after reload', () => {
    const blocks = projectAgenticTranscript([message('edit', 'assistant', 1, [
      { kind: 'tool_call', tool: 'edit', call_id: 'edit-one', args: { path: 'alpha.txt' } },
      { kind: 'tool_result', call_id: 'edit-one', result: { status: 'completed', diff: '-old\n+new' } },
    ])], []);
    expect(blocks.find(block => block.kind === 'diff')).toMatchObject({
      status: 'done', filePath: 'alpha.txt', diff: '-old\n+new', addedLines: 1, removedLines: 1,
    });
  });
  it('does not turn model-only or partial usage metadata into a zero total', () => {
    for (const usage of [{ model: 'provider/model' }, { model: 'provider/model', input_tokens: 12 }]) {
      expect(summarizeAgenticSession([message('usage', 'assistant', 1, [], usage)], []).tokenCount).toBe('—');
    }
    expect(summarizeAgenticSession([message('zero', 'assistant', 1, [], { input_tokens: 0, output_tokens: 0 })], []).tokenCount).toBe(0);
  });
  it('retains an explicit thinking signal when the provider supplies no displayable text', () => {
    const blocks = projectAgenticTranscript([message('signal', 'assistant', 1, [
      { kind: 'reasoning', text: '' },
    ])], []);
    expect(blocks).toEqual([expect.objectContaining({ kind: 'reasoning', text: '' })]);
  });
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

  it('preserves structured activity categories through transcript projection', () => {
    const blocks = projectAgenticTranscript(
      [],
      [
        {
          id: 'response',
          chatId: 'chat-1',
          kind: 'agent',
          category: 'response',
          status: 'running',
          title: 'Working',
          ts: 5,
        },
        {
          id: 'writing',
          chatId: 'chat-1',
          kind: 'diff',
          category: 'writing',
          status: 'running',
          title: 'Working',
          diff: '+change',
          ts: 6,
        },
      ],
    );

    expect(blocks).toEqual([
      expect.objectContaining({
        sourceId: 'activity:response',
        kind: 'activity',
        activityCategory: 'response',
      }),
      expect.objectContaining({
        sourceId: 'activity:writing',
        kind: 'diff',
        activityCategory: 'writing',
      }),
    ]);
  });

  it('preserves exact chronological ordering for interleaved and unordered sources', () => {
    const blocks = projectAgenticTranscript(
      [
        message('late', 'user', 30, [{ kind: 'text', text: 'Late prompt' }]),
        message('early', 'user', 10, [{ kind: 'text', text: 'Early prompt' }]),
      ],
      [
        {
          id: 'middle',
          chatId: 'chat-1',
          kind: 'tool',
          status: 'done',
          title: 'Middle activity',
          ts: 20,
        },
        {
          id: 'first',
          chatId: 'chat-1',
          kind: 'tool',
          status: 'done',
          title: 'First activity',
          ts: 5,
        },
      ],
    );

    expect(blocks.map((block) => block.sourceId)).toEqual([
      'activity:first',
      'message:early',
      'activity:middle',
      'message:late',
    ]);
  });

  it('merges already ordered canonical sources without changing interleaved order', () => {
    const blocks = projectAgenticTranscript(
      [
        message('first', 'user', 10, [{ kind: 'text', text: 'First prompt' }]),
        message('last', 'user', 30, [{ kind: 'text', text: 'Last prompt' }]),
      ],
      [
        {
          id: 'middle',
          chatId: 'chat-1',
          kind: 'tool',
          status: 'done',
          title: 'Middle activity',
          ts: 20,
        },
      ],
    );

    expect(blocks.map((block) => block.sourceId)).toEqual([
      'message:first',
      'activity:middle',
      'message:last',
    ]);
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

  it('projects only the ordered visible tail while matching the canonical full window exactly', () => {
    const messages = Array.from({ length: 500 }, (_, index) =>
      message(`message-${index}`, 'user', index * 10 + 1, [
        { kind: 'text', text: `Prompt ${index}` },
      ]),
    );
    const activity = Array.from({ length: 200 }, (_, index) => ({
      id: `activity-${index.toString().padStart(3, '0')}`,
      chatId: 'chat-1',
      kind: 'tool' as const,
      status: 'done' as const,
      title: `Activity ${index}`,
      ts: index * 10 + 5,
    }));
    const full = projectAgenticTranscript(messages, activity);

    const projected = projectAgenticTranscriptWindow(messages, activity, 400);

    expect(projected.total).toBe(full.length);
    expect(projected.remaining).toBe(300);
    expect(projected.visible).toEqual(windowTranscriptBlocks(full, 400).visible);
  });

  it('does not stringify historical payloads outside the ordered visible tail', () => {
    const poisonedArgs = {
      toJSON() {
        throw new Error('historical payload should not be projected');
      },
      toString() {
        throw new Error('historical payload should not be projected');
      },
    };
    const historical = message('historical-tool', 'assistant', 1, [
      {
        kind: 'tool_call',
        tool: 'custom.tool',
        args: poisonedArgs,
        call_id: 'historical-call',
      },
    ]);
    const recent = Array.from({ length: 400 }, (_, index) =>
      message(`recent-${index}`, 'user', index + 2, [{ kind: 'text', text: `Recent ${index}` }]),
    );

    const projected = projectAgenticTranscriptWindow([historical, ...recent], [], 400);

    expect(projected.total).toBe(401);
    expect(projected.remaining).toBe(1);
    expect(projected.visible).toHaveLength(400);
    expect(projected.visible[0]?.sourceId).toBe('message:recent-0');
  });

  it('falls back to exact full projection for unordered canonical inputs', () => {
    const messages = [
      message('late', 'user', 30, [{ kind: 'text', text: 'Late' }]),
      message('early', 'user', 10, [{ kind: 'text', text: 'Early' }]),
    ];
    const activity: ChatActivityEvent[] = [
      {
        id: 'later-activity',
        chatId: 'chat-1',
        kind: 'tool',
        status: 'done',
        title: 'Later',
        ts: 25,
      },
      {
        id: 'earlier-activity',
        chatId: 'chat-1',
        kind: 'tool',
        status: 'done',
        title: 'Earlier',
        ts: 5,
      },
    ];
    const full = projectAgenticTranscript(messages, activity);

    expect(projectAgenticTranscriptWindow(messages, activity, 3)).toEqual({
      ...windowTranscriptBlocks(full, 3),
      total: full.length,
    });
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
