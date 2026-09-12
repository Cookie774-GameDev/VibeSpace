import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('cold-start intro native authority', () => {
  it('uses a dedicated least-privilege capability that can complete the handoff', () => {
    const root = resolve(process.cwd(), 'src-tauri/capabilities');
    const defaults = JSON.parse(readFileSync(resolve(root, 'default.json'), 'utf8')) as {
      windows: string[];
    };
    const intro = JSON.parse(readFileSync(resolve(root, 'cold-start-intro.json'), 'utf8')) as {
      windows: string[];
      permissions: string[];
    };

    expect(defaults.windows).not.toContain('cold-start-intro');
    expect(intro.windows).toEqual(['cold-start-intro']);
    expect(intro.permissions).toEqual(
      expect.arrayContaining([
        'core:window:allow-show',
        'core:window:allow-unminimize',
        'core:window:allow-set-focus',
        'core:window:allow-close',
      ]),
    );
    expect(
      intro.permissions.some((permission) => /shell|process|updater|http/.test(permission)),
    ).toBe(false);
  });
});
