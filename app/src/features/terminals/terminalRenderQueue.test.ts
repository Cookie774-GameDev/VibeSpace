import { describe, expect, it } from 'vitest';
import { createTerminalRenderQueue } from './terminalRenderQueue';

describe('terminal render queue', () => {
  it('preserves ordered output below its bound', () => {
    const queue = createTerminalRenderQueue(32);
    queue.enqueue('one', 'one');
    queue.enqueue('two', 'two');

    expect(queue.drain()).toEqual({
      displayData: 'onetwo',
      transcriptData: 'onetwo',
      droppedCharacters: 0,
    });
  });

  it('drops only the oldest complete pending batches when a renderer falls behind', () => {
    const queue = createTerminalRenderQueue(8);
    queue.enqueue('1234', '1234');
    queue.enqueue('5678', '5678');
    queue.enqueue('abcd', 'abcd');

    expect(queue.drain()).toEqual({
      displayData: '5678abcd',
      transcriptData: '5678abcd',
      droppedCharacters: 4,
    });
  });

  it('drops one anomalously oversized batch whole instead of splitting Unicode or ANSI', () => {
    const queue = createTerminalRenderQueue(8);
    const oversized = '\u001b[31m😀😀😀😀\u001b[0m';

    queue.enqueue(oversized, oversized);

    expect(queue.drain()).toEqual({
      displayData: '',
      transcriptData: '',
      droppedCharacters: oversized.length,
    });
  });
});
