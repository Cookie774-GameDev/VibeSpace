/** Keep one native move in flight and replace queued pointer samples with the latest. */
export function createPetPositionQueue(move: (x: number, y: number) => Promise<void>) {
  let pending: { x: number; y: number } | null = null;
  let flight: Promise<void> | null = null;
  const drain = () => {
    if (flight || !pending) return;
    flight = (async () => {
      while (pending) {
        const next = pending;
        pending = null;
        try {
          await move(next.x, next.y);
        } catch {
          /* A closing native surface can reject. */
        }
      }
    })().finally(() => {
      flight = null;
      drain();
    });
  };
  return {
    push(x: number, y: number) {
      pending = { x, y };
      drain();
    },
    async flush() {
      while (flight) await flight;
    },
    clear() {
      pending = null;
    },
  };
}
