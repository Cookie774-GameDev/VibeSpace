import { describe, expect, it } from 'vitest';
import { projectOpenCodePublicTimeline } from './openCodePublicTimeline';

describe('projectOpenCodePublicTimeline', () => {
  it('relativizes diff metadata headers without rewriting actual changed content', () => {
    const diff = 'Index: C:/fixture/alpha.txt\n--- C:/fixture/alpha.txt\n+++ C:/fixture/alpha.txt\n@@ -1 +1 @@\n--- C:/fixture/content\n+++ C:/fixture/content';
    const snapshot = projectOpenCodePublicTimeline([{info: {role: 'assistant'}, parts: [{type: 'tool', tool: 'edit', callID: 'edit', state: {status: 'completed', input: {path: 'C:/fixture/alpha.txt'}, metadata: {diff}}}]}], {workingDirectory: 'C:/fixture'});
    expect(snapshot.timeline.find(part => part.kind === 'tool_result')).toMatchObject({result: {diff: 'Index: alpha.txt\n--- alpha.txt\n+++ alpha.txt\n@@ -1 +1 @@\n--- C:/fixture/content\n+++ C:/fixture/content'}});
  });
  it('preserves independent native task identities and public progress without copying prompts', () => {
    const snapshot = projectOpenCodePublicTimeline([{ info: { role: 'assistant' }, parts: [
      { type: 'tool', tool: 'task', callID: 'call-a', state: { status: 'running', input: { description: 'Read alpha', prompt: 'PRIVATE TASK PROMPT' }, metadata: { sessionId: 'session-a', summary: [{ tool: 'read', state: { title: 'Reading alpha.txt', status: 'running' } }] } } },
      { type: 'tool', tool: 'task', callID: 'call-b', state: { status: 'completed', input: { description: 'Read beta' }, metadata: { sessionId: 'session-b' } } },
    ] }]);
    const tasks = snapshot.timeline.filter(part => part.kind === 'tool_call').map(part => part.args.nativeTask);
    expect(tasks).toEqual([
      expect.objectContaining({ sessionId: 'session-a', name: 'Read alpha', currentStep: 'Reading alpha.txt' }),
      expect.objectContaining({ sessionId: 'session-b', name: 'Read beta' }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE TASK PROMPT');
  });

  it('shows a nonzero shell exit as failure even when the transport completed', () => {
    const snapshot = projectOpenCodePublicTimeline([{ info: { role: 'assistant' }, parts: [
      { type: 'tool', tool: 'bash', callID: 'exit-seven', state: { status: 'completed', metadata: { exit: 7 } } },
    ] }]);
    expect(snapshot.timeline).toContainEqual({ kind: 'tool_result', call_id: 'opencode-tool-1', error: 'Command exited with code 7' });
  });

  it('keeps distinct project-relative file identities without exposing paths outside the root', () => {
    const snapshot = projectOpenCodePublicTimeline([{info: {role: 'assistant'}, parts: [
      ...['C:/fixture/src/alpha.txt', 'C:/fixture/test/alpha.txt', 'C:/outside/private.txt'].map((path, index) => ({
        type: 'tool', tool: 'read', callID: `read-${index}`, state: {status: 'completed', input: {path}},
      })),
    ]}], {workingDirectory: 'C:/fixture'});
    expect(snapshot.timeline.filter(part => part.kind === 'tool_call').map(part => part.args.path))
      .toEqual(['src/alpha.txt', 'test/alpha.txt', 'private.txt']);
  });
  it('distinguishes an empty Context boundary from a generic tool failure', () => {
    const snapshot = projectOpenCodePublicTimeline([
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'tool',
            tool: 'vibespace_context',
            callID: 'private-context-call',
            state: {
              status: 'completed',
              output: JSON.stringify({
                requestId: 'private-request',
                ok: false,
                code: 'context_unavailable',
                message: 'Required VibeSpace project context was unavailable.',
                data: {
                  receiptId: 'private-receipt',
                  scopeRevision: { projectId: 'private-project' },
                },
              }),
            },
          },
          { type: 'text', text: 'No project evidence was available, so I did not guess.' },
        ],
      },
    ]);

    expect(snapshot).toEqual({
      finalText: 'No project evidence was available, so I did not guess.',
      timeline: [
        { kind: 'tool_call', tool: 'vibespace_context', call_id: 'opencode-tool-1', args: {} },
        {
          kind: 'tool_result',
          call_id: 'opencode-tool-1',
          error: 'Context unavailable',
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /private-request|private-receipt|private-project/iu,
    );
  });

  it('separates the last public OpenCode answer from the ordered checkpoint and tool timeline', () => {
    const snapshot = projectOpenCodePublicTimeline([
      {
        info: { id: 'private-user-message', role: 'user' },
        parts: [{ type: 'text', text: 'Make the game.' }],
      },
      {
        info: { id: 'private-assistant-1', role: 'assistant' },
        parts: [
          { type: 'text', text: "I'll inspect the existing files first." },
          {
            id: 'private-tool-part-read',
            type: 'tool',
            tool: 'read',
            callID: 'private-call-read',
            state: {
              status: 'completed',
              input: { filePath: 'C:\\Users\\private\\game.js', content: 'must-not-survive' },
              output: 'must-not-survive',
            },
          },
        ],
      },
      {
        info: { id: 'private-assistant-2', role: 'assistant' },
        parts: [
          { type: 'text', text: "The structure is clear. I'm implementing the scene now." },
          {
            type: 'tool',
            tool: 'edit',
            callID: 'private-call-edit',
            state: {
              status: 'running',
              input: { path: '/private/player.js', patch: 'must-not-survive' },
            },
          },
        ],
      },
      {
        info: { id: 'private-assistant-3', role: 'assistant' },
        parts: [{ type: 'text', text: 'Everything is finished and tested successfully.' }],
      },
    ]);

    expect(snapshot.finalText).toBe('Everything is finished and tested successfully.');
    expect(snapshot.timeline).toEqual([
      { kind: 'text', text: "I'll inspect the existing files first." },
      {
        kind: 'tool_call',
        tool: 'read',
        call_id: 'opencode-tool-1',
        args: { path: 'game.js' },
      },
      {
        kind: 'tool_result',
        call_id: 'opencode-tool-1',
        result: { status: 'completed' },
      },
      { kind: 'text', text: "The structure is clear. I'm implementing the scene now." },
      {
        kind: 'tool_call',
        tool: 'edit',
        call_id: 'opencode-tool-2',
        args: { path: 'player.js' },
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /private-user|private-assistant|private-call|Users|must-not-survive/iu,
    );
  });

  it('retains provider-exposed reasoning and failed public tool state', () => {
    const snapshot = projectOpenCodePublicTimeline([
      {
        info: { role: 'assistant' },
        parts: [
          { type: 'reasoning', text: 'Checking the fixture.' },
          { type: 'step-start', text: 'private phase' },
          { type: 'text', text: 'I am checking the game.' },
          {
            type: 'tool',
            name: 'bash',
            id: 'private-bash-id',
            state: { status: 'failed', input: { command: 'secret command' } },
          },
          { type: 'agent_message', text: 'The test failed safely.' },
        ],
      },
    ]);

    expect(snapshot).toEqual({
      finalText: 'The test failed safely.',
      timeline: [
        { kind: 'reasoning', text: 'Checking the fixture.' },
        { kind: 'text', text: 'I am checking the game.' },
        { kind: 'tool_call', tool: 'bash', call_id: 'opencode-tool-1', args: {} },
        { kind: 'tool_result', call_id: 'opencode-tool-1', error: 'Tool failed' },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /private phase|secret command|private-bash/iu,
    );
  });

  it('projects a completed transport with a failed Context envelope as a failed tool', () => {
    const snapshot = projectOpenCodePublicTimeline([
      {
        info: { role: 'assistant' },
        parts: [
          { type: 'text', text: 'I am checking the active project context.' },
          {
            type: 'tool',
            tool: 'vibespace_context',
            callID: 'private-context-call',
            state: {
              status: 'completed',
              input: { operation: 'investigate', query: 'private project question' },
              output: JSON.stringify({
                requestId: 'private-request-id',
                ok: false,
                code: 'tool_failed',
                message: 'The semantic tool could not be completed.',
              }),
            },
          },
          { type: 'text', text: 'Project context was unavailable, so I did not guess.' },
        ],
      },
    ]);

    expect(snapshot).toEqual({
      finalText: 'Project context was unavailable, so I did not guess.',
      timeline: [
        { kind: 'text', text: 'I am checking the active project context.' },
        {
          kind: 'tool_call',
          tool: 'vibespace_context',
          call_id: 'opencode-tool-1',
          args: {},
        },
        { kind: 'tool_result', call_id: 'opencode-tool-1', error: 'Tool failed' },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/private-request|private project question/iu);
  });

  it('produces stable request-local identities when the same persisted snapshot is projected again', () => {
    const messages = [
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'tool',
            tool: 'write',
            callID: 'native-call-z',
            state: { status: 'completed', input: { path: 'C:\\private\\index.html' } },
          },
          { type: 'text', text: 'Done.' },
        ],
      },
    ];

    expect(projectOpenCodePublicTimeline(messages)).toEqual(
      projectOpenCodePublicTimeline(messages),
    );
  });

  it('collapses repeated persisted updates for one native tool call into one terminal lifecycle', () => {
    const snapshot = projectOpenCodePublicTimeline([
      {
        info: { role: 'assistant' },
        parts: [
          { type: 'text', text: 'I am reading the game file.' },
          {
            type: 'tool',
            tool: 'read',
            callID: 'private-call-read',
            state: { status: 'running', input: { path: 'C:\\private\\game.js' } },
          },
        ],
      },
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'tool',
            tool: 'read',
            callID: 'private-call-read',
            state: {
              status: 'completed',
              input: { path: 'C:\\private\\game.js' },
              output: 'must-not-survive',
            },
          },
          { type: 'text', text: 'The game file is ready.' },
        ],
      },
    ]);

    expect(snapshot).toEqual({
      finalText: 'The game file is ready.',
      timeline: [
        { kind: 'text', text: 'I am reading the game file.' },
        {
          kind: 'tool_call',
          tool: 'read',
          call_id: 'opencode-tool-1',
          args: { path: 'game.js' },
        },
        {
          kind: 'tool_result',
          call_id: 'opencode-tool-1',
          result: { status: 'completed' },
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/private-call|must-not-survive|C:\\\\private/iu);
  });

  it('retains a confirmed provider diff but never treats a running proposal as applied', () => {
    const make = (status: string) => projectOpenCodePublicTimeline([{ info: { role: 'assistant' }, parts: [
      { type: 'tool', tool: 'edit', callID: 'edit-one', state: { status, input: { filePath: 'src/alpha.txt' }, metadata: { diff: '-old\n+new' } } },
    ] }]);
    expect(make('running').timeline).toEqual([{ kind: 'tool_call', tool: 'edit', call_id: 'opencode-tool-1', args: { path: 'src/alpha.txt' } }]);
    expect(make('completed').timeline[1]).toEqual({ kind: 'tool_result', call_id: 'opencode-tool-1', result: { status: 'completed', diff: '-old\n+new' } });
  });

  it('streams supported thinking and running tools before any final answer exists', () => {
    expect(
      projectOpenCodePublicTimeline([
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'reasoning', text: 'Checking the fixture.' },
            { type: 'tool', tool: 'read', callID: 'live-read', state: { status: 'running', input: { path: 'alpha.txt' } } },
          ],
        },
      ]),
    ).toEqual({ finalText: '', timeline: [
      { kind: 'reasoning', text: 'Checking the fixture.' },
      { kind: 'tool_call', tool: 'read', call_id: 'opencode-tool-1', args: { path: 'alpha.txt' } },
    ] });
  });
});
