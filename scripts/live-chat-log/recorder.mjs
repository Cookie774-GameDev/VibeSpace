import { mkdir, readFile, writeFile, appendFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function createFileRecorder(directory, maxBytes = 32 * 1024 * 1024) {
  await mkdir(directory, { recursive: true });
  const eventsPath = join(directory, 'events.jsonl');
  const statusPath = join(directory, 'status.json');
  await appendFile(eventsPath, '', 'utf8');
  let cursors = {};
  try { cursors = JSON.parse(await readFile(statusPath, 'utf8')).cursors ?? {}; } catch { /* first run */ }
  async function status(value) {
    await writeFile(statusPath + '.tmp', JSON.stringify({ ...value, cursors, updatedAt: Date.now(), eventsPath }, null, 2));
    await rename(statusPath + '.tmp', statusPath);
  }
  return {
    async accept(snapshot) {
      const key = snapshot.instanceId;
      const cursor = cursors[key] ?? 0;
      const fresh = snapshot.events.filter(event => event.sequence > cursor);
      const lines = fresh.map(event => JSON.stringify({ schemaVersion: 1, instanceId: key, persistedAt: Date.now(), event }));
      const gap = fresh.length ? Math.max(0, fresh[0].sequence - cursor - 1) : 0;
      if (gap) lines.unshift(JSON.stringify({ schemaVersion: 1, instanceId: key, persistedAt: Date.now(), gap, reason: 'Events no longer available in renderer buffer' }));
      if (lines.length) {
        const size = await stat(eventsPath).then(info => info.size, () => 0);
        if (size > maxBytes) await rename(eventsPath, eventsPath + '.previous');
        await appendFile(eventsPath, lines.join('\n') + '\n', 'utf8');
      }
      cursors[key] = snapshot.sequence;
      // Keep the latest eight renderer generations; old files remain readable.
      cursors = Object.fromEntries(Object.entries(cursors).slice(-8));
      await status({ connected: true, instanceId: key, sequence: snapshot.sequence, active: snapshot.active ?? [], gapThisRead: gap, coverage: snapshot.coverage, lastEvent: snapshot.events.at(-1) ?? null });
    },
    async disconnected() { await status({ connected: false, reason: 'Native recorder unavailable; retrying. No new observations.' }); },
  };
}
