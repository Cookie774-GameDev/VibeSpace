import { describe, expect, it } from 'vitest';
import main from '../../../src-tauri/capabilities/default.json';
import workbench from '../../../src-tauri/capabilities/workbench.json';

describe('packaged GitHub device authorization permissions', () => {
  it.each([main, workbench])(
    '$identifier permits both device-flow requests without a broad GitHub grant',
    (capability) => {
      const urls = capability.permissions.flatMap((permission) =>
        typeof permission === 'object' && permission.identifier === 'http:default'
          ? permission.allow.map((rule) => rule.url)
          : [],
      );
      expect(urls).toContain('https://github.com/login/device/code');
      expect(urls).toContain('https://github.com/login/oauth/access_token');
      expect(urls).not.toContain('https://github.com/*');
    },
  );
});
