import { describe, expect, it } from 'vitest';
import { parseOpenCodeSse } from './sseParser';

function stream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 7));
      controller.enqueue(bytes.slice(7));
      controller.close();
    },
  });
}

describe('parseOpenCodeSse', () => {
  it('parses chunked CRLF events, ids, and multiline data', async () => {
    const events = [];
    for await (const event of parseOpenCodeSse(
      stream('id: 42\r\nevent: message\r\ndata: {"one":1}\r\ndata: second\r\n\r\n'),
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        id: '42',
        event: 'message',
        data: '{"one":1}\nsecond',
      },
    ]);
  });

  it('rejects an unbounded event buffer', async () => {
    const consume = async () => {
      for await (const _event of parseOpenCodeSse(stream(`data: ${'x'.repeat(128)}`), undefined, {
        maxBufferBytes: 64,
        maxEventBytes: 64,
      })) {
        // consume
      }
    };

    await expect(consume()).rejects.toThrow('SSE event exceeded');
  });

  it('stops cleanly when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const events = [];

    for await (const event of parseOpenCodeSse(
      stream('data: {"type":"ignored"}\n\n'),
      controller.signal,
    )) {
      events.push(event);
    }

    expect(events).toEqual([]);
  });
});
