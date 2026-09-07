// Isolated source-pattern check and scenario arithmetic. Never imports/starts the app.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const source = fs.readFileSync('app/src/lib/ai/runtime.ts', 'utf8');
const start = source.indexOf('    const settleStreamingWrites = async () => {');
const end = source.indexOf('\n    };', start) + '\n    };'.length;
assert(start >= 0 && end > start);
const helper = source.slice(start, end);
assert(helper.includes('while (pendingStreamingWrites.size > 0)'));

async function probe(snapshot) {
  const pending = new Set();
  let release;
  const older = new Promise(resolve => { release = resolve; });
  pending.add(older);
  void older.then(() => pending.delete(older));
  const settle = snapshot
    ? () => Promise.allSettled([...pending])
    : new Function('pendingStreamingWrites', `${helper}\nreturn settleStreamingWrites;`)(pending);
  let updates = 0;
  let completed = false;
  const resolutionWrite = settle().then(() => { updates++; });
  pending.add(resolutionWrite);
  void resolutionWrite.then(() => { pending.delete(resolutionWrite); completed = true; });
  release();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return { pending: pending.size, updates, completed };
}
const currentPattern = await probe(false);
const predecessorSnapshotModel = await probe(true);
assert.deepEqual(currentPattern, { pending: 1, updates: 0, completed: false });
assert.deepEqual(predecessorSnapshotModel, { pending: 0, updates: 1, completed: true });
const reduction = (before, after) => 100 * (1 - after / before);
console.log(JSON.stringify({
  scope: 'isolated extracted helper plus modeled handler ordering; not native/provider reproduction',
  helperSourceStartLine: source.slice(0, start).split('\n').length,
  currentPattern, predecessorSnapshotModel,
  scenariosNotAppBenchmarks: {
    syncQueue: { pendingRows: 20000, matchingRows: 1, candidateVisitReductionPercent: reduction(20000, 1) },
    codexFrames: { maxFrameMiB: 4, channelSlots: 256, encodedPayloadCeilingMiB: 1024, proposedBudgetMiB: 16, ceilingReductionPercent: reduction(1024, 16) },
    terminal: { oldBatchKiB: 4, fullProposedBatchKiB: 64, fullBatchEventReductionPercent: reduction(64 / 4, 1) },
    history: { totalMessages: 20000, displayedMessages: 400, initialRowReductionPercent: reduction(20000, 400) },
  },
}, null, 2));
