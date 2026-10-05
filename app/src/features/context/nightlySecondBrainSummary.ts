import { compareAndSwapTextFile, createDirectory, readTextFile } from '@/lib/fs';
import { joinPath } from '@/features/files/projectFiles';
import type { SecondBrainChange } from './nightlySecondBrain';

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function secondBrainSummaryPath(
  root: string,
  scopeKey: string,
  window: { start: number; end: number },
): Promise<string> {
  if (
    !root ||
    !scopeKey ||
    !Number.isSafeInteger(window.start) ||
    !Number.isSafeInteger(window.end) ||
    window.start < 0 ||
    window.end < window.start
  )
    throw new Error('Invalid summary scope or coverage interval.');
  return joinPath(
    root,
    `.vibespace/second-brain/${await digest(scopeKey)}/${window.start}-${window.end}.md`,
  );
}

export const productionSummaryPorts = {
  async read(path: string, root: string): Promise<string | null> {
    const result = await readTextFile(path, { root });
    if (result.ok) return result.content;
    if (result.error.code === 'not_found') return null;
    throw new Error(`Could not read managed summary (${result.error.code}).`);
  },
  async mkdir(path: string, root: string): Promise<void> {
    const result = await createDirectory(path, { root });
    if (!result.ok) throw new Error(`Could not create summary folder (${result.error.code}).`);
  },
  async replace(
    path: string,
    expected: string | null,
    content: string,
    root: string,
  ): Promise<void> {
    const hash = expected === null ? null : (`sha256:${await digest(expected)}` as const);
    const result = await compareAndSwapTextFile(path, hash, content, { root });
    if (!result.ok) throw new Error(`Could not save managed summary (${result.error.code}).`);
  },
};

async function coveragePath(root: string, scopeKey: string): Promise<string> {
  const summary = await secondBrainSummaryPath(root, scopeKey, { start: 0, end: 0 });
  return summary.slice(0, summary.lastIndexOf('/')) + '/coverage.json';
}

async function readCoverage(root: string, scopeKey: string, ports: typeof productionSummaryPorts) {
  const path = await coveragePath(root, scopeKey);
  const content = await ports.read(path, root);
  if (content === null) return { path, content, coveredThrough: 0 };
  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid second-brain coverage ledger.');
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    record.scopeDigest !== (await digest(scopeKey)) ||
    !Number.isSafeInteger(record.coveredThrough) ||
    (record.coveredThrough as number) < 0
  )
    throw new Error('Invalid second-brain coverage ledger.');
  return { path, content, coveredThrough: record.coveredThrough as number };
}

export async function readSecondBrainCoverage(
  root: string,
  scopeKey: string,
  ports = productionSummaryPorts,
): Promise<number> {
  return (await readCoverage(root, scopeKey, ports)).coveredThrough;
}

/** Called only after all generated summary writes have succeeded and been read back. */
export async function commitSecondBrainCoverage(input: {
  root: string;
  scopeKey: string;
  start: number;
  end: number;
  assertActive(): void;
  ports?: typeof productionSummaryPorts;
}): Promise<void> {
  const ports = input.ports ?? productionSummaryPorts;
  await secondBrainSummaryPath(input.root, input.scopeKey, input);
  input.assertActive();
  const before = await readCoverage(input.root, input.scopeKey, ports);
  if (before.coveredThrough >= input.end) return;
  if (input.start > before.coveredThrough)
    throw new Error('Second-brain coverage has an unprocessed gap.');
  const after = JSON.stringify({
    version: 1,
    scopeDigest: await digest(input.scopeKey),
    coveredThrough: input.end,
  });
  input.assertActive();
  await ports.mkdir(before.path.slice(0, before.path.lastIndexOf('/')), input.root);
  input.assertActive();
  await ports.replace(before.path, before.content, after, input.root);
  input.assertActive();
  if ((await ports.read(before.path, input.root)) !== after)
    throw new Error('Second-brain coverage write could not be verified.');
}

export async function writeManagedSecondBrainSummary(input: {
  change: SecondBrainChange;
  direction: 'apply' | 'rollback';
  root: string;
  scopeKey: string;
  assertActive(): void;
  ports?: typeof productionSummaryPorts;
}): Promise<void> {
  const { change, root, scopeKey, direction } = input;
  if (!change.managedSummary || change.target !== 'related_markdown' || change.before !== '')
    throw new Error('Invalid managed summary change.');
  const marker = change.after.split('\n', 1)[0]!;
  const match = /^<!-- VibeSpace Second Brain ([a-f0-9]{64}) (\d+)-(\d+) -->$/u.exec(marker);
  if (!match || match[1] !== (await digest(scopeKey)))
    throw new Error('Managed summary belongs to another scope.');
  const expectedPath = await secondBrainSummaryPath(root, scopeKey, {
    start: Number(match[2]),
    end: Number(match[3]),
  });
  if (change.path.replace(/\\/gu, '/') !== expectedPath.replace(/\\/gu, '/'))
    throw new Error('Managed summary path changed.');
  const ports = input.ports ?? productionSummaryPorts;
  input.assertActive();
  const current = await ports.read(expectedPath, root);
  const rollback = `${marker}\n\n# Second Brain summary withdrawn\n\nThis generated summary was rolled back.\n`;
  const wanted = direction === 'apply' ? change.after : rollback;
  if (current === wanted) return;
  if (current !== null && current !== change.after && current !== rollback)
    throw new Error('Managed summary changed since review; refusing to overwrite it.');
  if (direction === 'rollback' && current === null) throw new Error('Managed summary is missing.');
  input.assertActive();
  await ports.mkdir(expectedPath.slice(0, expectedPath.lastIndexOf('/')), root);
  input.assertActive();
  await ports.replace(expectedPath, current, wanted, root);
  input.assertActive();
  if ((await ports.read(expectedPath, root)) !== wanted)
    throw new Error('Managed summary write could not be verified.');
}

export async function secondBrainSummaryMarker(
  scopeKey: string,
  window: { start: number; end: number },
): Promise<string> {
  return `<!-- VibeSpace Second Brain ${await digest(scopeKey)} ${window.start}-${window.end} -->`;
}
