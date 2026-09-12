import { describe, expect, it } from 'vitest';
import { collectAuditEvidence, auditInstruction } from './auditEvidence';
import type { Message } from '@/types/chat';
import type { ChatActivityEvent } from '../activity/types';

describe('VibeCheck evidence', () => {
  it('does not invent missing diff totals', () => {
    expect(collectAuditEvidence([], []).added).toBeNull();
    expect(collectAuditEvidence([], []).coverage).toContain('unknown');
  });
  it('deduplicates tool calls and counts commands by tool identity, not prose', () => {
    const messages = [
      {
        parts: [
          { kind: 'tool_call', call_id: 'a', tool: 'exec_command' },
          { kind: 'tool_call', call_id: 'a', tool: 'exec_command' },
          { kind: 'tool_call', call_id: 'b', tool: 'read_file' },
          { kind: 'text', text: 'Ran 100 commands' },
        ],
      },
    ] as Message[];
    expect(collectAuditEvidence(messages, [])).toMatchObject({ commands: 1, toolCalls: 2 });
  });
  it('counts only completed recorded diffs and preserves unknown sides', () => {
    const events = [
      { id: 'a', kind: 'diff', status: 'done', filePath: 'a.ts', addedLines: 4, removedLines: 2 },
      { id: 'b', kind: 'diff', status: 'running', filePath: 'b.ts', addedLines: 500 },
    ] as ChatActivityEvent[];
    expect(collectAuditEvidence([], events)).toMatchObject({ added: 4, removed: 2 });
    expect(
      collectAuditEvidence(
        [],
        [...events, { id: 'c', kind: 'diff', status: 'done', addedLines: 1 } as ChatActivityEvent],
      ).removed,
    ).toBeNull();
  });
  it('requires evidence and forbids implementation or unsolicited delegation', () => {
    const prompt = auditInstruction('Example', collectAuditEvidence([], []));
    expect(prompt).toContain('read-only');
    expect(prompt).toContain('Do not edit files');
    expect(prompt).toContain('follow nextOffset');
  });
});
