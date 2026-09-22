import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export function startupIdentity(base, stateDir, node = process.execPath) {
  // Windows file paths cannot contain double quotes. Reject them before producing a Run command.
  for (const value of [base, stateDir, node])
    if (/["\r\n]/.test(value)) throw Error('Invalid startup path.');
  const launch = `wscript.exe //B //Nologo "${path.join(base, 'startup.vbs')}" "${path.relative(base, node)}" "supervisor.mjs" "${path.relative(base, path.resolve(stateDir)) || '.'}"`;
  if (launch.length > 260)
    throw Error('Windows startup command is too long (260 characters maximum).');
  return {
    name:
      'VibeSpaceDesktopLink-' +
      createHash('sha256').update(path.resolve(stateDir).toLowerCase()).digest('hex').slice(0, 16),
    launch,
  };
}
export function computerStartup(base, stateDir, enabled, execute = execFile) {
  if (process.platform !== 'win32')
    return Promise.reject(Error('Computer startup requires Windows.'));
  const { name, launch } = startupIdentity(base, stateDir);
  return new Promise((resolve, reject) => {
    execute(
      existsSync(path.join(base, 'runtime', 'node.exe'))
        ? path.join(base, 'runtime', 'python', 'python.exe')
        : 'python.exe',
      [
        '-I',
        '-S',
        '-B',
        path.join(base, 'setup', 'windows-startup.py'),
        name,
        launch,
        enabled === undefined ? 'get' : enabled ? 'on' : 'off',
      ],
      { windowsHide: true, shell: false, timeout: 10000, maxBuffer: 4096 },
      (error, stdout) => {
        if (error || !['true', 'false'].includes(stdout.trim()))
          return reject(Error('Could not verify Windows startup registration.'));
        const actual = stdout.trim() === 'true';
        if (enabled !== undefined && enabled !== actual)
          return reject(Error('Windows startup change was not applied.'));
        resolve(actual);
      },
    );
  });
}
