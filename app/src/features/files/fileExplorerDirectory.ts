import { listDirectory, type FsAccessOptions, type FsListResult } from '@/lib/fs';

/** Bound native IPC for every interactive Files tree, including a stalled invoke. */
export function listExplorerDirectory(
  path: string,
  options: FsAccessOptions = {},
): Promise<FsListResult> {
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(
      () =>
        resolve({
          ok: false,
          path,
          error: {
            code: 'runtime_failure',
            raw: 'This folder is taking too long to load. Refresh or choose another folder.',
          },
        }),
      4_000,
    );
    void listDirectory(path, options).then(
      (result) => {
        globalThis.clearTimeout(timer);
        resolve(result);
      },
      () => {
        globalThis.clearTimeout(timer);
        resolve({
          ok: false,
          path,
          error: {
            code: 'runtime_failure',
            raw: 'Could not load this folder. Refresh to try again.',
          },
        });
      },
    );
  });
}
