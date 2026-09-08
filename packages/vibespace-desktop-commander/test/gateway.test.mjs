import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startGateway } from '../gateway.mjs';
import { validateSetting } from '../config.mjs';
import { buildInvocation } from '../browser/browser.mjs';

test('gateway authenticates, validates, saves through MCP, reads back and rejects stale writes', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'vibespace-dc-test-'));
  const config = {
    blockedCommands: ['format'],
    allowedDirectories: [],
    defaultShell: 'powershell.exe',
    telemetryEnabled: false,
    fileReadLineLimit: 10000,
    fileWriteLineLimit: 50000,
  };
  let writes = 0;
  const client = {
    close: async () => {},
    callTool: async ({ name, arguments: args }) => {
      if (name === 'set_config_value') {
        writes++;
        config[args.key] = args.value;
        return { content: [] };
      }
      return {
        structuredContent: {
          config: { ...config },
          uiHints: { availableShells: ['powershell.exe'] },
        },
      };
    },
  };
  const gateway = await startGateway({ client, stateDir, port: 0 });
  const headers = { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' };
  const patch = (body) =>
    fetch(gateway.endpoint + '/config', { method: 'PATCH', headers, body: JSON.stringify(body) });
  try {
    // Tauri plugin-http appends the native window origin even though it bypasses CORS.
    for (const origin of ['tauri://localhost', 'http://tauri.localhost', 'http://localhost:5174']) {
      assert.equal(
        (await fetch(gateway.endpoint + '/config', { headers: { ...headers, origin } })).status,
        200,
      );
      assert.equal(
        (await fetch(gateway.endpoint + '/config', { headers: { origin } })).status,
        401,
      );
      assert.equal(
        (await fetch(gateway.endpoint + '/mcp', { headers: { ...headers, origin } })).status,
        401,
      );
    }
    assert.equal((await fetch(gateway.endpoint + '/config')).status, 401);
    assert.equal(
      (
        await fetch(gateway.endpoint + '/config', {
          headers: { ...headers, origin: 'https://attacker.invalid' },
        })
      ).status,
      401,
    );
    const rebound = await new Promise((resolve, reject) => {
      const req = http.get(
        gateway.endpoint + '/config',
        { headers: { ...headers, host: 'attacker.invalid' } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.once('error', reject);
    });
    assert.equal(rebound, 401);
    assert.equal(
      (await patch({ key: 'fileReadLineLimit', value: 12345, previous: 10000 })).status,
      200,
    );
    const read = await (await fetch(gateway.endpoint + '/config', { headers })).json();
    assert.equal(read.config.fileReadLineLimit, 12345);
    assert.equal(writes, 1);
    assert.equal(
      (await patch({ key: 'fileReadLineLimit', value: 999, previous: 10000 })).status,
      409,
    );
    assert.equal((await patch({ key: 'apiKey', value: 'bad', previous: null })).status, 400);
    assert.equal(
      (await patch({ key: 'fileReadLineLimit', value: 1.5, previous: 12345 })).status,
      400,
    );
    assert.equal(writes, 1);
    assert.equal(
      (await patch({ key: 'allowedDirectories', value: ['C:\\workspace'], previous: [] })).status,
      200,
    );
    assert.deepEqual(config.allowedDirectories, ['C:\\workspace']);
  } finally {
    await gateway.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
test('configuration types and limits reject unsafe values', () => {
  for (const value of [0, -1, Infinity, 1.2, 1000001, '100'])
    assert.throws(() => validateSetting('fileWriteLineLimit', value));
  assert.throws(() => validateSetting('telemetryEnabled', 'false'));
  assert.throws(() => validateSetting('defaultShell', 'pwsh\nanything'));
  assert.throws(() => validateSetting('blockedCommands', ['']));
  assert.throws(() => validateSetting('allowedDirectories', Array(501).fill('C:\\x')));
  assert.deepEqual(validateSetting('allowedDirectories', []), []);
});
test('packaged browser retains scoped sessions and no attach/global shutdown', () => {
  for (const command of ['attach', 'close-all', 'kill-all'])
    assert.throws(() => buildInvocation('test', [command]));
  assert.throws(() => buildInvocation('../other', ['snapshot']));
  assert.throws(() => buildInvocation('test', ['open', 'https://example.com', '--cdp=9238']));
  const invocation = buildInvocation('test', ['snapshot']);
  assert.ok(invocation.cwd.endsWith(path.join('workspaces', 'test')));
});
