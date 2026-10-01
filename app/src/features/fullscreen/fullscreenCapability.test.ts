import { describe, expect, it } from 'vitest';
import defaultCapability from '../../../src-tauri/capabilities/default.json';
import workbenchCapability from '../../../src-tauri/capabilities/workbench.json';

describe('packaged system fullscreen capability', () => {
  it.each([
    ['main app', defaultCapability],
    ['detached Workbench', workbenchCapability],
  ])('allows %s windows to change native fullscreen', (_surface, capability) => {
    expect(capability.permissions).toContain('core:window:allow-set-fullscreen');
    expect(capability.permissions).toContain('core:window:allow-show');
    expect(capability.permissions).toContain('core:window:allow-unminimize');
    expect(capability.permissions).toContain('core:window:allow-set-focus');
  });
});
