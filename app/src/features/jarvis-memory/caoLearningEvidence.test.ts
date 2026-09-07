import { expect, it } from 'vitest';
import type { Message } from '@/types';
import { collectCaoLearningEvidence } from './caoLearningEvidence';

it('preserves wording, replies, file/tool actions and provenance without hidden reasoning or secrets', () => {
  const messages = [
    {
      id: 'u1',
      chat_id: 'chat1',
      role: 'user',
      created_at: 1,
      parts: [{ kind: 'text', text: 'PLEASE fix only app.ts and ask before sending.' }],
    },
    {
      id: 'a1',
      chat_id: 'chat1',
      role: 'assistant',
      agent_id: 'codex',
      created_at: 2,
      parts: [
        { kind: 'text', text: 'Updated app.ts; checks passed.' },
        { kind: 'reasoning', text: 'PRIVATE REASONING' },
        {
          kind: 'tool_call',
          tool: 'edit_file',
          call_id: 'c1',
          args: { path: 'app.ts', api_key: 'secret-value' },
        },
        { kind: 'tool_result', call_id: 'c1', result: 'changed app.ts' },
      ],
    },
    {
      id: 'foreign',
      chat_id: 'other',
      role: 'user',
      created_at: 3,
      parts: [{ kind: 'text', text: 'FOREIGN' }],
    },
  ] as Message[];
  const evidence = collectCaoLearningEvidence(messages, ['chat1']);
  expect(evidence.sourceIds).toEqual(['u1', 'a1']);
  expect(evidence.text).toContain('PLEASE fix only app.ts');
  expect(evidence.text).toContain('edit_file');
  expect(evidence.text).toContain('changed app.ts');
  expect(evidence.text).not.toMatch(/PRIVATE REASONING|secret-value|FOREIGN/);
});

it('bounds recent evidence and identifies truncation rather than claiming complete history', () => {
  const messages = Array.from({ length: 250 }, (_, i) => ({
    id: `m${i}`,
    chat_id: 'chat',
    role: 'user',
    created_at: i,
    parts: [{ kind: 'text', text: 'x'.repeat(5000) }],
  })) as Message[];
  const evidence = collectCaoLearningEvidence(messages, ['chat']);
  expect(evidence.text.length).toBeLessThanOrEqual(80000);
  expect(evidence.truncated).toBe(true);
  expect(evidence.sourceIds).toContain('m249');
});
