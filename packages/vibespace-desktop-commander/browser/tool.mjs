import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildInvocation } from './browser.mjs';
export const browserTool = {
  name: 'browser_command',
  description:
    'Use Playwright in an isolated Microsoft Edge session. Start with args ["open","https://example.com"], then ["snapshot"], ["click","e12"], ["fill","e8","text"], or ["press","Enter"]. Read snapshot references before acting. Use a unique session per task. Ask before sending, submitting, purchases, uploads or downloads. On timeout inspect the same session; never blindly repeat an action. Not for attaching to VibeSpace native windows.',
  inputSchema: {
    type: 'object',
    properties: { session: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } },
    required: ['session', 'args'],
    additionalProperties: false,
  },
};
export async function runBrowserTool({ session, args }) {
  buildInvocation(session, args);
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./cli.mjs', import.meta.url)), '--session', session, ...args],
      { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      settled = false;
    const finish = (text, isError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ content: [{ type: 'text', text }], isError });
    };
    const capture = (chunk) => {
      if (output.length < 64000) output += chunk.toString().slice(0, 64000 - output.length);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timer = setTimeout(
      () =>
        finish(
          'Browser command is still running. Inspect the same session after it completes; do not repeat the action.',
          true,
        ),
      55000,
    );
    child.once('error', () =>
      finish('Unable to start the packaged browser helper. Run npm run browser:install.', true),
    );
    child.once('exit', (code) =>
      finish(output || `Browser command exited with code ${code}.`, code !== 0),
    );
  });
}
