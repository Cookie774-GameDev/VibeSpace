import { describe, expect, it } from 'vitest';
import { CONTEXT_MIME } from '@/features/context/tree';
import {
  FILE_MIME,
  TERMINAL_MIME,
  getChatDragKind,
  getChatDropPayload,
} from './dropPayload';

function dataTransfer(types: string[], values: Record<string, string>) {
  return {
    types,
    getData(type: string) {
      return values[type] ?? '';
    },
  };
}

describe('chat drop payloads', () => {
  it('prefers rich context over file path when context rows provide both', () => {
    const payload = getChatDropPayload(dataTransfer(
      [CONTEXT_MIME, FILE_MIME, 'text/plain'],
      {
        [CONTEXT_MIME]: '{"title":"Context file","summary":"Use this"}',
        [FILE_MIME]: 'C:\\repo\\src\\App.tsx',
        'text/plain': 'C:\\repo\\src\\App.tsx',
      },
    ));

    expect(payload).toEqual({
      kind: 'context',
      raw: '{"title":"Context file","summary":"Use this"}',
    });
  });

  it('prefers terminal references over text fallback', () => {
    const payload = getChatDropPayload(dataTransfer(
      [TERMINAL_MIME, 'text/plain'],
      {
        [TERMINAL_MIME]: '{"sessionId":"term-1","label":"Claude"}',
        'text/plain': 'terminal:Claude',
      },
    ));

    expect(payload).toEqual({
      kind: 'terminal',
      raw: '{"sessionId":"term-1","label":"Claude"}',
    });
  });

  it('keeps plain file drags as file attachments', () => {
    const payload = getChatDropPayload(dataTransfer(
      [FILE_MIME, 'text/plain'],
      {
        [FILE_MIME]: 'D:\\project\\README.md',
        'text/plain': 'D:\\project\\README.md',
      },
    ));

    expect(payload).toEqual({ kind: 'file', path: 'D:\\project\\README.md' });
  });

  it('classifies drag-over state without reading protected drop data', () => {
    expect(getChatDragKind([CONTEXT_MIME, FILE_MIME])).toBe('context');
    expect(getChatDragKind([TERMINAL_MIME, 'text/plain'])).toBe('terminal');
    expect(getChatDragKind(['text/plain'])).toBe('file');
    expect(getChatDragKind(['text/html'])).toBeNull();
  });
});
