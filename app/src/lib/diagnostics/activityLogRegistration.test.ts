import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
it('registers only the fixed diagnostics command on the ordinary native builder', () => {
  const lib = source('src-tauri/src/lib.rs');
  const visual = lib.slice(
    lib.indexOf('fn run_monochrome_visual_test('),
    lib.indexOf('fn run_ordinary('),
  );
  const ordinary = lib.slice(
    lib.indexOf('fn run_ordinary('),
    lib.indexOf('#[cfg(test)]', lib.indexOf('fn run_ordinary(')),
  );
  expect(lib).toContain('mod activity_diagnostics;');
  expect(lib).toContain('mod activity_diagnostics_store;');
  expect(ordinary).toContain('activity_diagnostics::activity_diagnostics_append,');
  expect(visual).not.toContain('activity_diagnostics');
  const command = source('src-tauri/src/activity_diagnostics.rs');
  expect(command).toContain('ensure_main_caller(window.label(), window.window().label())?');
  expect(command).toContain('spawn_blocking');
  expect(command).toContain('.app_log_dir()');
  expect(command).not.toContain('directory: String');
});
it('connects startup and disposal to the bounded diagnostic lifecycle', () => {
  const bootstrap = source('src/bootstrapApp.tsx');
  expect(bootstrap).toContain('startActivityLogPersistence');
  expect(bootstrap).toContain('const stopActivityLogPersistence = startActivityLogPersistence();');
  expect(bootstrap).toContain('void stopActivityLogPersistence();');
});
