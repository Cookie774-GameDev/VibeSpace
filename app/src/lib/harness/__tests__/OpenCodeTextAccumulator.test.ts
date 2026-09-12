import { describe, expect, it } from 'vitest';
import {
  extractOpenCodeTextPartUpdate,
  OpenCodeTextAccumulator,
} from '../OpenCodeTextAccumulator';

describe('OpenCodeTextAccumulator', () => {
  it('recovers full text when OpenCode omits delta', () => {
    const accumulator = new OpenCodeTextAccumulator();
    expect(accumulator.ingest({ channel: 'text', partId: 'p', text: 'Hello' })).toMatchObject({
      kind: 'delta', text: 'Hello', fullText: 'Hello',
    });
    expect(accumulator.ingest({ channel: 'text', partId: 'p', text: 'Hello world' })).toMatchObject({
      kind: 'delta', text: ' world', fullText: 'Hello world',
    });
    expect(accumulator.fullText()).toBe('Hello world');
  });

  it('supports delta-only streams and ignores duplicate/stale snapshots', () => {
    const accumulator = new OpenCodeTextAccumulator();
    accumulator.ingest({ channel: 'text', partId: 'p', eventId: '1', delta: 'Hello' });
    expect(accumulator.ingest({ channel: 'text', partId: 'p', eventId: '1', delta: 'Hello' }).kind).toBe('noop');
    expect(accumulator.ingest({ channel: 'text', partId: 'p', text: 'Hel' }).kind).toBe('noop');
    expect(accumulator.fullText()).toBe('Hello');
  });

  it('reports an explicit replacement for an upstream correction', () => {
    const accumulator = new OpenCodeTextAccumulator();
    accumulator.ingest({ channel: 'text', partId: 'p', text: 'draft' });
    expect(accumulator.ingest({ channel: 'text', partId: 'p', text: 'final' })).toEqual({
      kind: 'replace', channel: 'text', partKey: '["","","p","text"]', text: 'final', fullText: 'final',
    });
  });

  it('extracts message.part.updated snapshots and deltas', () => {
    expect(extractOpenCodeTextPartUpdate({
      type: 'message.part.updated',
      properties: {
        delta: '!',
        part: { id: 'p1', messageID: 'm1', sessionID: 's1', type: 'text', text: 'Hello!' },
      },
    })).toEqual({
      eventId: undefined,
      sessionId: 's1',
      messageId: 'm1',
      partId: 'p1',
      channel: 'text',
      delta: '!',
      text: 'Hello!',
    });
  });

  it('fails closed on unbounded output', () => {
    const accumulator = new OpenCodeTextAccumulator({ maxTotalChars: 5 });
    expect(() => accumulator.ingest({ channel: 'text', text: '123456' })).toThrow(
      'HARNESS_TEXT_LIMIT_EXCEEDED',
    );
  });
});
