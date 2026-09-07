import { createDirectory, readTextFile, writeTextFile } from '@/lib/fs';
import { getJarvisRootDir, joinPath } from '@/features/files/projectFiles';

import { privateAccountDirectory } from './accountStorage';

export interface LearningFileIo {
  resolveRoot: () => Promise<string>;
  createDirectory: (path: string) => Promise<void>;
  readText: (path: string) => Promise<string | null>;
  writeText: (path: string, value: string) => Promise<void>;
}

export interface LearningFileResult {
  path: string;
  markdown: string;
  recovered: boolean;
  recoverySource: 'backup' | 'temporary' | null;
}

const EMPTY_LEARNING = '# Jarvis Learning\n\nNo saved learning yet.\n';

function valid(markdown: string | null): markdown is string {
  return Boolean(markdown?.startsWith('# Jarvis Learning\n') && markdown.length <= 512 * 1024);
}

async function writeAndVerify(
  io: LearningFileIo,
  path: string,
  markdown: string,
  failure: string,
): Promise<void> {
  await io.writeText(path, markdown);
  const persisted = await io.readText(path);
  if (persisted !== markdown || !valid(persisted)) throw new Error(failure);
}

async function paths(root: string, accountId: string) {
  const directory = joinPath(
    joinPath(root, 'Jarvis Memory'),
    await privateAccountDirectory(accountId),
  );
  const primary = joinPath(directory, 'learning.md');
  return {
    directory,
    primary,
    backup: `${primary}.bak`,
    temporary: `${primary}.tmp`,
  };
}

const nativeIo: LearningFileIo = {
  resolveRoot: getJarvisRootDir,
  createDirectory: async (path) => {
    const result = await createDirectory(path);
    if (!result.ok)
      throw new Error(`Could not create private memory directory (${result.error.code}).`);
  },
  readText: async (path) => {
    const result = await readTextFile(path);
    if (result.ok) return result.content;
    if (result.error.code === 'not_found' || result.error.code === 'unavailable') return null;
    throw new Error(`Could not read private memory (${result.error.code}).`);
  },
  writeText: async (path, value) => {
    const result = await writeTextFile(path, value);
    if (!result.ok) throw new Error(`Could not write private memory (${result.error.code}).`);
  },
};

// Listener saves, model reviews, and recovery share the same primary/backup/temp files.
// Serialize their native I/O so an overlapping save cannot corrupt another save's readback.
const fileOperations = new WeakMap<LearningFileIo, Map<string, Promise<void>>>();
function withLearningFile<T>(
  io: LearningFileIo,
  accountId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let accounts = fileOperations.get(io);
  if (!accounts) {
    accounts = new Map();
    fileOperations.set(io, accounts);
  }
  const result = (accounts.get(accountId) ?? Promise.resolve()).then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  accounts.set(accountId, settled);
  void settled.then(() => {
    if (accounts!.get(accountId) === settled) accounts!.delete(accountId);
  });
  return result;
}

export function saveLearningFile(
  accountId: string,
  markdown: string,
  io: LearningFileIo = nativeIo,
): Promise<LearningFileResult> {
  return withLearningFile(io, accountId, () => saveLearningFileUnlocked(accountId, markdown, io));
}

async function saveLearningFileUnlocked(
  accountId: string,
  markdown: string,
  io: LearningFileIo = nativeIo,
): Promise<LearningFileResult> {
  if (!accountId.trim()) throw new Error('Account id is required for learning memory.');
  if (!valid(markdown))
    throw new Error(
      'learning.md must begin with the Jarvis Learning heading and remain under 512 KB.',
    );
  const root = await io.resolveRoot();
  if (!root) throw new Error('Private app-data storage is unavailable.');
  const target = await paths(root, accountId);
  await io.createDirectory(target.directory);
  const current = await io.readText(target.primary);
  if (valid(current)) await io.writeText(target.backup, current);
  await io.writeText(target.temporary, markdown);
  await writeAndVerify(io, target.primary, markdown, 'Learning persistence could not be verified.');
  return { path: target.primary, markdown, recovered: false, recoverySource: null };
}

export function loadLearningFile(
  accountId: string,
  io: LearningFileIo = nativeIo,
): Promise<LearningFileResult> {
  return withLearningFile(io, accountId, () => loadLearningFileUnlocked(accountId, io));
}

async function loadLearningFileUnlocked(
  accountId: string,
  io: LearningFileIo = nativeIo,
): Promise<LearningFileResult> {
  if (!accountId.trim()) throw new Error('Account id is required for learning memory.');
  const root = await io.resolveRoot();
  if (!root) throw new Error('Private app-data storage is unavailable.');
  const target = await paths(root, accountId);
  await io.createDirectory(target.directory);
  const primary = await io.readText(target.primary);
  if (valid(primary)) {
    return { path: target.primary, markdown: primary, recovered: false, recoverySource: null };
  }
  const backup = await io.readText(target.backup);
  if (valid(backup)) {
    await writeAndVerify(
      io,
      target.primary,
      backup,
      'Learning recovery repair could not be verified.',
    );
    return { path: target.primary, markdown: backup, recovered: true, recoverySource: 'backup' };
  }
  const temporary = await io.readText(target.temporary);
  if (valid(temporary)) {
    await writeAndVerify(
      io,
      target.primary,
      temporary,
      'Learning recovery repair could not be verified.',
    );
    return {
      path: target.primary,
      markdown: temporary,
      recovered: true,
      recoverySource: 'temporary',
    };
  }
  if (primary !== null || backup !== null || temporary !== null) {
    throw new Error('Learning recovery failed because persisted candidates are corrupt.');
  }
  return {
    path: target.primary,
    markdown: EMPTY_LEARNING,
    recovered: false,
    recoverySource: null,
  };
}
