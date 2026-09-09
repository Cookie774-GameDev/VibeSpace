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
