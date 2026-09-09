import { describe, expect, it } from 'vitest';
import main from '../../../src-tauri/capabilities/default.json';
import workbench from '../../../src-tauri/capabilities/workbench.json';

describe('native Deepgram network access', () => {
  it.each([main, workbench])('$identifier allows Deepgram without unrestricted HTTPS access', (capability) => {
    const urls = capability.permissions.flatMap(permission =>
      typeof permission === 'object' && permission.identifier === 'http:default'
        ? permission.allow.map(rule => rule.url) : []);
    expect(urls).toContain('https://api.deepgram.com/*');
    expect(urls).not.toContain('https://*/*');
  });
});
