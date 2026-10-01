export const MAX_PENDING_TERMINAL_OUTPUT_CHARACTERS = 262_144;

interface PendingTerminalBatch {
  displayData: string;
  transcriptData: string;
  size: number;
}

export interface DrainedTerminalOutput {
  displayData: string;
  transcriptData: string;
  droppedCharacters: number;
}

export function createTerminalRenderQueue(maxCharacters = MAX_PENDING_TERMINAL_OUTPUT_CHARACTERS) {
  const batches: PendingTerminalBatch[] = [];
  let size = 0;
  let droppedCharacters = 0;

  return {
    enqueue(displayData: string, transcriptData: string) {
      if (!displayData) return;
      const batch = {
        displayData,
        transcriptData,
        size: Math.max(displayData.length, transcriptData.length),
      };
      if (batch.size > maxCharacters) {
        droppedCharacters += displayData.length;
        return;
      }
      batches.push(batch);
      size += batch.size;

      while (size > maxCharacters && batches.length > 1) {
        const dropped = batches.shift();
        if (!dropped) break;
        size -= dropped.size;
        droppedCharacters += dropped.displayData.length;
      }
    },
    drain(): DrainedTerminalOutput | null {
      if (batches.length === 0 && droppedCharacters === 0) return null;
      const drained = {
        displayData: batches.map((batch) => batch.displayData).join(''),
        transcriptData: batches.map((batch) => batch.transcriptData).join(''),
        droppedCharacters,
      };
      batches.length = 0;
      size = 0;
      droppedCharacters = 0;
      return drained;
    },
    isEmpty() {
      return batches.length === 0 && droppedCharacters === 0;
    },
    clear() {
      batches.length = 0;
      size = 0;
      droppedCharacters = 0;
    },
  };
}
