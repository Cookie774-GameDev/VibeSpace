import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startupIdentity, computerStartup } from '../startup.mjs';
import { recoveryDelay } from '../supervisor.mjs';
test('startup identity isolates profiles and hides the sign-in launcher', () => {
  const a = startupIdentity(
    'C:/Application Space',
    'C:/profile-a',
    'C:/Application Space/node.exe',
  );
  assert.equal(a.name, startupIdentity('C:/Application Space', 'C:/profile-a').name);
  assert.notEqual(a.name, startupIdentity('C:/Application Space', 'C:/profile-b').name);
  assert.match(a.launch, /^wscript.exe \/\/B \/\/Nologo /);
  assert.throws(() => startupIdentity('C:/bad"path', 'C:/profile'));
  assert.deepEqual([0, 1, 2, 20].map(recoveryDelay), [1000, 2000, 4000, 30000]);
});
test(
  'startup changes require registry readback; no real registry writes',
  { skip: process.platform !== 'win32' },
  async () => {
    const execute = (_program, args, options, done) => {
      assert.equal(options.windowsHide, true);
      assert.equal(args.at(-1), 'on');
      done(null, 'true');
    };
    assert.equal(await computerStartup('C:/app', 'C:/fixture', true, execute), true);
    await assert.rejects(
      computerStartup('C:/app', 'C:/fixture', true, (_p, _a, _o, done) => done(null, 'false')),
      /not applied/,
    );
  },
);

test(
  'startup registration uses the bundled Windows helper, not a PowerShell dependency',
  { skip: process.platform !== 'win32' },
  async () => {
    const execute = (program, args, _options, done) => {
      assert.ok(!/powershell/i.test(program));
      assert.ok(args.some((arg) => String(arg).endsWith('windows-startup.py')));
      done(null, 'false');
    };
    assert.equal(await computerStartup('C:/app', 'C:/fixture', undefined, execute), false);
  },
);

test('packaged startup command fits Windows Run limit even with a hashed installation path', () => {
  const base =
    'C:/Users/example/AppData/Local/ai.jarvis.desktop/desktop-connector/' + 'a'.repeat(64);
  const state = 'C:/Users/example/AppData/Local/ai.jarvis.desktop/desktop-connector/state';
  const identity = startupIdentity(base, state, base + '/runtime/node.exe');
  assert.ok(identity.launch.length <= 260, 'Windows Run command must not exceed 260 characters');
  assert.match(identity.launch, /"runtime[\\/]node.exe" "supervisor.mjs" "\.\.[\\/]state"$/);
  assert.throws(() => startupIdentity('C:/' + 'x'.repeat(300), state), /260|too long/i);
});
