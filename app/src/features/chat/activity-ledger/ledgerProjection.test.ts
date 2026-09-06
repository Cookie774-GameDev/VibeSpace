import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import type { ChatActivityEvent } from '../activity/types';
import { MAX_LEDGER_RECEIPTS, projectAssistantActivityLedger } from './ledgerProjection';

function assistant(parts: Message['parts'], usage?: Message['usage']): Message {
  return {
    id: 'message-ledger' as Message['id'],
    chat_id: 'chat-ledger' as Message['chat_id'],
    role: 'assistant',
    parts,
    created_at: 100,
    updated_at: 200,
    ...(usage ? { usage } : {}),
  };
}

function event(
  input: Partial<ChatActivityEvent> & Pick<ChatActivityEvent, 'id'>,
): ChatActivityEvent {
  return {
    chatId: 'chat-ledger',
    kind: 'tool',
    status: 'done',
    title: 'Activity',
    ts: 100,
    ...input,
  };
}

describe('projectAssistantActivityLedger', () => {
  it('projects a settled protected file action as one truthful receipt without raw content', () => {
    const ledger = projectAssistantActivityLedger(
      assistant([
        {
          kind: 'action_proposal',
          call_id: 'jarvisapproval:read-1',
          action_id: 'files.read',
          params: { path: 'C:\\project\\brief.md' },
          status: 'success',
          result: {
            ok: true,
            summary: 'Read the approved file.',
            data: { path: 'C:\\project\\brief.md', content: 'private file contents' },
          },
        },
      ]),
    );

    expect(ledger.actionsTotal).toBe(1);
    expect(ledger.readsTotal).toBe(1);
    expect(ledger.receipts).toEqual([
      expect.objectContaining({
        kind: 'read',
        label: 'Read file',
        fileLabel: 'brief.md',
        status: 'done',
      }),
    ]);
    expect(JSON.stringify(ledger)).not.toContain('private file contents');
  });

  it('projects a command once and never retains its body, args, output, or secrets', () => {
    const ledger = projectAssistantActivityLedger(
      assistant([
        {
          kind: 'tool_call',
          call_id: 'call-1',
          tool: 'terminal.exec',
          args: { command: 'curl https://private.test --data "opaque-sensitive-payload"' },
        },
        {
          kind: 'tool_result',
          call_id: 'call-1',
          result: { stdout: 'super-secret-output', exitCode: 0, durationMs: 42 },
        },
      ]),
    );

    expect(ledger.commandsTotal).toBe(1);
    expect(ledger.actionsTotal).toBe(1);
    expect(ledger.receipts).toHaveLength(1);
    expect(ledger.receipts[0]).toMatchObject({
      kind: 'command',
      label: 'Ran command',
      status: 'done',
    });
    expect(JSON.stringify(ledger)).not.toContain('opaque-sensitive-payload');
    expect(JSON.stringify(ledger)).not.toContain('super-secret-output');
    expect(JSON.stringify(ledger)).not.toContain('private.test');
  });

  it('retains exact sanitized command and tool identity for explicit disclosure', () => {
    const providerSecret = ['sk', 'proj', '1234567890abcdefghijklmnop'].join('-');
    const ledger = projectAssistantActivityLedger(
      assistant([
        {
          kind: 'tool_call',
          call_id: 'command-safe',
          tool: 'terminal.exec',
          args: { command: 'npm test -- src/publicActivity.test.ts' },
        },
        { kind: 'tool_result', call_id: 'command-safe', result: { exitCode: 0 } },
        {
          kind: 'tool_call',
          call_id: 'tool-safe',
          tool: 'mcp.cloudflare.deploy_worker',
          args: { apiKey: providerSecret },
        },
        { kind: 'tool_result', call_id: 'tool-safe', result: { status: 'completed' } },
      ]),
    );

    expect(ledger.receipts).toEqual([
      expect.objectContaining({
        kind: 'command',
        detail: 'npm test -- src/publicActivity.test.ts',
      }),
      expect.objectContaining({ kind: 'other', detail: 'mcp.cloudflare.deploy_worker' }),
    ]);
    expect(JSON.stringify(ledger)).not.toContain(providerSecret);
  });

  it('projects every canonical tool lifecycle with structured command/read/search/edit/check kinds', () => {
    const ledger = projectAssistantActivityLedger(assistant([]), [
      event({
        id: 'command',
        title: 'Jarvis terminal activity',
        detail: 'npm run typecheck',
        ts: 101,
      }),
      event({
        id: 'read',
        title: 'Jarvis tool activity',
        subtitle: 'read',
        detail: 'Read App.tsx',
        ts: 102,
      }),
      event({
        id: 'search',
        title: 'Jarvis tool activity',
        subtitle: 'grep',
        detail: 'Search tests',
        ts: 103,
      }),
      event({
        id: 'edit',
        title: 'Jarvis tool activity',
        subtitle: 'apply_patch',
        detail: 'Edit App.tsx',
        ts: 104,
      }),
      event({
        id: 'check',
        title: 'Jarvis tool activity',
        subtitle: 'verify.test',
        detail: 'Run tests',
        ts: 105,
      }),
      event({
        id: 'tool',
        title: 'Jarvis tool activity',
        subtitle: 'custom.tool',
        detail: 'Custom work',
        ts: 106,
      }),
    ]);

    expect(ledger.actionsTotal).toBe(6);
    expect(ledger.receipts.map(({ kind }) => kind)).toEqual([
      'command',
      'read',
      'search',
      'edit',
      'check',
      'other',
    ]);
    expect(ledger.receipts.map(({ detail }) => detail)).toEqual([
      'npm run typecheck',
      'Read App.tsx',
      'Search tests',
      'Edit App.tsx',
      'Run tests',
      'Custom work',
    ]);
  });

  it('deduplicates replayed message tool calls by stable call id and uses the latest result status', () => {
    const ledger = projectAssistantActivityLedger(
      assistant([
        {
          kind: 'tool_call',
          call_id: 'replayed',
          tool: 'terminal.exec',
          args: { command: 'first' },
        },
        { kind: 'tool_result', call_id: 'replayed', result: { exitCode: 0 } },
        {
          kind: 'tool_call',
          call_id: 'replayed',
          tool: 'terminal.exec',
          args: { command: 'second' },
        },
        { kind: 'tool_result', call_id: 'replayed', result: { exitCode: -7 } },
      ]),
    );
    expect(ledger.actionsTotal).toBe(1);
    expect(ledger.commandsTotal).toBe(1);
    expect(ledger.receipts).toHaveLength(1);
    expect(ledger.receipts[0]).toMatchObject({ status: 'error', label: 'Command failed' });
    expect(JSON.stringify(ledger)).not.toContain('first');
    expect(JSON.stringify(ledger)).not.toContain('second');
  });

  it('deduplicates replayed correlated events and maps only explicit successful evidence', () => {
    const events = [
      event({
        id: 'read-1',
        kind: 'tool',
        category: 'file',
        status: 'running',
        title: 'Opaque file activity',
        filePath: 'README.md',
        ts: 100,
      }),
      event({
        id: 'read-1',
        kind: 'tool',
        category: 'file',
        title: 'Different replay prose',
        filePath: 'README.md',
        status: 'done',
        ts: 101,
      }),
      event({ id: 'search-1', kind: 'url', category: 'context', title: 'Opaque retrieval' }),
      event({
        id: 'edit-1',
        kind: 'diff',
        category: 'writing',
        title: 'Edited source file',
        filePath: 'src/a.ts',
      }),
      event({ id: 'generic-check-title', title: 'Verified focused tests' }),
      event({
        id: 'generic-subagent',
        kind: 'subagent',
        category: 'coordination',
        title: 'Coordinating worker',
        agentSlug: 'worker-a',
      }),
    ];

    const ledger = projectAssistantActivityLedger(
      assistant([
        { kind: 'tool_call', call_id: 'check-ok', tool: 'verify.test', args: {} },
        { kind: 'tool_result', call_id: 'check-ok', result: { exitCode: 0 } },
        { kind: 'tool_call', call_id: 'check-failed', tool: 'verify.test', args: {} },
        { kind: 'tool_result', call_id: 'check-failed', result: { exitCode: -1 } },
        { kind: 'tool_call', call_id: 'sub-1', tool: 'agents.spawn_agent', args: {} },
        { kind: 'tool_result', call_id: 'sub-1', result: { exitCode: 0 } },
      ]),
      events,
    );
    expect(ledger).toMatchObject({
      actionsTotal: 7,
      readsTotal: 1,
      searchesTotal: 1,
      editedFilesTotal: 1,
      verifiedChecksTotal: 1,
      failedChecksTotal: 1,
      subagentsTotal: 2,
    });
    expect(ledger.receipts.find((receipt) => receipt.id === 'activity:read-1')?.status).toBe(
      'done',
    );
  });

  it('distinguishes an explicitly created file from a generic edit receipt', () => {
    const ledger = projectAssistantActivityLedger(assistant([]), [
      event({
        id: 'create-1',
        kind: 'diff',
        category: 'writing',
        title: 'Created report.ts',
        filePath: 'src/report.ts',
        status: 'done',
      }),
    ]);

    expect(ledger.receipts[0]).toMatchObject({
      kind: 'edit',
      label: 'Created file',
      fileLabel: 'report.ts',
    });
  });

  it('honors explicit file and subagent event kinds without requiring optional categories', () => {
    const ledger = projectAssistantActivityLedger(assistant([]), [
      event({
        id: 'explicit-file',
        kind: 'file',
        title: 'Opaque file activity',
        filePath: 'src/feature.ts',
      }),
      event({
        id: 'explicit-subagent',
        kind: 'subagent',
        title: 'Opaque delegated activity',
        agentSlug: 'worker-one',
      }),
    ]);

    expect(ledger).toMatchObject({
      actionsTotal: 2,
      readsTotal: 1,
      subagentsTotal: 1,
    });
    expect(ledger.receipts.map((receipt) => receipt.kind)).toEqual(['read', 'subagent']);
  });

  it('projects only privacy-safe leaf file labels while retaining preview authority', () => {
    const windowsPath = 'C:\\private\\planning\\AlphaPlan.ts';
    const posixPath = '/private/build/BetaBuild.ts';
    const ledger = projectAssistantActivityLedger(assistant([]), [
      event({ id: 'windows-file', kind: 'file', filePath: windowsPath }),
      event({ id: 'posix-file', kind: 'file', filePath: posixPath }),
    ]);

    expect(ledger.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filePath: windowsPath, fileLabel: 'AlphaPlan.ts' }),
        expect.objectContaining({ filePath: posixPath, fileLabel: 'BetaBuild.ts' }),
      ]),
    );
    expect(ledger.receipts.map((receipt) => receipt.fileLabel).join(' ')).not.toContain('private');
  });

  it('projects only the safe basename from a message-correlated file tool argument', () => {
    const ledger = projectAssistantActivityLedger(
      assistant([
        {
          kind: 'tool_call',
          call_id: 'message-read',
          tool: 'read_file',
          args: { path: 'C:\\private\\planning\\AgenticConsole.tsx' },
        },
        { kind: 'tool_result', call_id: 'message-read', result: { exitCode: 0 } },
      ]),
    );

    expect(ledger.receipts[0]).toMatchObject({
      kind: 'read',
      label: 'Read file',
      fileLabel: 'AgenticConsole.tsx',
    });
    expect(JSON.stringify(ledger)).not.toContain('private');
    expect(JSON.stringify(ledger)).not.toContain('planning');
  });

  it('counts unique completed files and distinct started subagent executions', () => {
    const ledger = projectAssistantActivityLedger(assistant([]), [
      event({ id: 'read-a', kind: 'file', filePath: 'src/a.ts', status: 'done' }),
      event({ id: 'read-b', kind: 'file', filePath: 'src/a.ts', status: 'done' }),
      event({ id: 'read-running', kind: 'file', filePath: 'src/b.ts', status: 'running' }),
      event({ id: 'read-failed', kind: 'file', filePath: 'src/c.ts', status: 'error' }),
      event({
        id: 'sub-running',
        kind: 'subagent',
        agentSlug: 'worker',
        status: 'running',
      }),
      event({ id: 'sub-done', kind: 'subagent', agentSlug: 'worker', status: 'done' }),
      event({ id: 'sub-failed', kind: 'subagent', agentSlug: 'other', status: 'error' }),
    ]);

    expect(ledger.readsTotal).toBe(1);
    expect(ledger.subagentsTotal).toBe(2);
  });

  it('uses the latest authoritative terminal end when exact usage and correlated evidence coexist', () => {
    const ledger = projectAssistantActivityLedger(
      assistant([], { input_tokens: 10, output_tokens: 2 }),
      [
        event({
          id: 'later-search',
          kind: 'url',
          startedAt: 100,
          endedAt: 61_100,
          status: 'done',
        }),
      ],
    );

    expect(ledger.endedAt).toBe(61_100);
    expect(ledger.durationMs).toBe(61_000);
  });

  it('uses authoritative terminal event timestamps when explicit endedAt is unavailable', () => {
    const ledger = projectAssistantActivityLedger(assistant([]), [
      event({ id: 'started', status: 'done', ts: 100, startedAt: 100 }),
      event({ id: 'finished', status: 'done', ts: 61_100 }),
    ]);

    expect(ledger.endedAt).toBe(61_100);
    expect(ledger.durationMs).toBe(61_000);
  });

  it('uses generic lifecycle events for timing and status without fabricating action receipts', () => {
    const ledger = projectAssistantActivityLedger(assistant([{ kind: 'text', text: 'Done.' }]), [
      event({ id: 'request-queued', status: 'pending', ts: 100 }),
      event({ id: 'request-running', status: 'running', ts: 150 }),
      event({ id: 'request-complete', status: 'done', ts: 7_100 }),
    ]);

    expect(ledger).toMatchObject({
      status: 'running',
      actionsTotal: 0,
      currentOperation: 'Activity running',
      omittedReceipts: 0,
    });
    expect(ledger.durationMs).toBeUndefined();
    expect(ledger.receipts).toEqual([]);
  });

  it('uses the stable assistant message interval when terminal receipts have no end timestamp', () => {
    const ledger = projectAssistantActivityLedger(
      assistant([
        { kind: 'tool_call', call_id: 'command-duration', tool: 'terminal.exec', args: {} },
        { kind: 'tool_result', call_id: 'command-duration', result: { exitCode: 0 } },
      ]),
    );

    expect(ledger.endedAt).toBe(200);
    expect(ledger.durationMs).toBe(100);
  });

  it('preserves unavailable and estimated response provenance', () => {
    const unavailable = projectAssistantActivityLedger(assistant([], { input_tokens: 0, output_tokens: 0, provenance: 'unavailable' }));
    expect(unavailable.usage.input).toMatchObject({ value: null, provenance: 'unavailable' });
    expect(unavailable.usage.output).toMatchObject({ value: null, provenance: 'unavailable' });
    const estimated = projectAssistantActivityLedger(assistant([], { input_tokens: 12, output_tokens: 7, provenance: 'estimated' }));
    expect(estimated.usage.input).toMatchObject({ value: 12, provenance: 'estimated' });
    expect(estimated.usage.output).toMatchObject({ value: 7, provenance: 'estimated' });
  });

  it('keeps provider usage exact, optimizer-only input estimated, and missing output unavailable', () => {
    const exact = projectAssistantActivityLedger(
      assistant([], {
        input_tokens: 12,
        output_tokens: 7,
        provider: 'opencode' as never,
        model: 'm',
      }),
    );
    expect(exact.usage).toEqual({
      input: { value: 12, provenance: 'exact', source: 'response-metadata' },
      output: { value: 7, provenance: 'exact', source: 'response-metadata' },
    });

    const estimated = projectAssistantActivityLedger(
      assistant([
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
      ]),
    );
    expect(estimated.usage).toEqual({
      input: { value: 15, provenance: 'estimated', source: 'local-estimate' },
      output: { value: null, provenance: 'unavailable', source: 'unavailable' },
    });
  });

  it('bounds retained detail while preserving truthful aggregate totals', () => {
    const events = Array.from({ length: MAX_LEDGER_RECEIPTS + 25 }, (_, index) =>
      event({
        id: `read-${index}`,
        kind: 'tool',
        category: 'file',
        title: 'Opaque file activity',
        filePath: `f-${index}.ts`,
        ts: index,
      }),
    );
    const ledger = projectAssistantActivityLedger(assistant([]), events);
    expect(ledger.actionsTotal).toBe(MAX_LEDGER_RECEIPTS + 25);
    expect(ledger.readsTotal).toBe(MAX_LEDGER_RECEIPTS + 25);
    expect(ledger.receipts).toHaveLength(MAX_LEDGER_RECEIPTS);
    expect(ledger.omittedReceipts).toBe(25);
  });

  it('projects a 250,000-event restored turn within the bounded render budget', () => {
    const events = Array.from({ length: 250_000 }, (_, index) =>
      event({
        id: `large-read-${index}`,
        kind: 'file',
        title: 'Opaque file activity',
        filePath: `fixture/f-${index}.ts`,
        ts: index,
      }),
    );

    const startedAt = performance.now();
    const ledger = projectAssistantActivityLedger(assistant([]), events);
    const elapsedMs = performance.now() - startedAt;

    expect(ledger.actionsTotal).toBe(250_000);
    expect(ledger.readsTotal).toBe(250_000);
    expect(ledger.receipts).toHaveLength(MAX_LEDGER_RECEIPTS);
    expect(ledger.omittedReceipts).toBe(250_000 - MAX_LEDGER_RECEIPTS);
    expect(elapsedMs).toBeLessThan(750);
  });

  it('preserves an omitted running receipt and the newest out-of-order detail truth', () => {
    const events = [
      event({ id: 'running-old', status: 'running', ts: 1 }),
      ...Array.from({ length: MAX_LEDGER_RECEIPTS + 20 }, (_, index) =>
        event({ id: `done-${index}`, kind: 'file', status: 'done', ts: index + 10 }),
      ),
      event({ id: 'late-arriving-middle', kind: 'file', status: 'done', ts: 50 }),
    ];

    const ledger = projectAssistantActivityLedger(assistant([]), events);

    expect(ledger.status).toBe('running');
    expect(ledger.currentOperation).toBe('Activity running');
    expect(ledger.receipts.some((receipt) => receipt.id === 'activity:done-519')).toBe(true);
    expect(ledger.receipts.some((receipt) => receipt.id === 'activity:running-old')).toBe(false);
  });

  it('keeps an unknown persisted message tool as a safe generic action without exposing payloads', () => {
    const ledger = projectAssistantActivityLedger(
      assistant([
        {
          kind: 'tool_call',
          call_id: 'unknown-1',
          tool: 'custom.private_tool',
          args: { secret: 'never-render-this' },
        },
        { kind: 'tool_result', call_id: 'unknown-1', result: { value: 'private-result' } },
      ]),
    );
    expect(ledger.actionsTotal).toBe(1);
    expect(ledger.receipts[0]).toMatchObject({
      kind: 'other',
      label: 'Completed activity',
      countsAsAction: true,
    });
    expect(JSON.stringify(ledger)).not.toContain('never-render-this');
    expect(JSON.stringify(ledger)).not.toContain('private-result');
  });
});
