import { describe, expect, it } from 'vitest';

import { capabilityCatalog } from '../src/catalog';

describe('VibeSpace MCP capability catalog', () => {
  it('exposes connected read tools and labels unimplemented mutations truthfully', () => {
    const catalog = capabilityCatalog(true, ['fs.list', 'fs.read']);
    expect(catalog.find((tool) => tool.id === 'files.read')).toMatchObject({
      available: true,
      approval_required: false,
    });
    expect(catalog.find((tool) => tool.id === 'terminal.run')).toMatchObject({
      available: false,
      approval_required: true,
      unavailable_reason: expect.stringMatching(/not implemented/i),
    });
    expect(catalog.find((tool) => tool.id === 'browser.playwright')).toMatchObject({
      available: false,
      approval_required: true,
      unavailable_reason: expect.stringMatching(/not implemented/i),
    });
  });

  it('does not fabricate read availability while the desktop is offline', () => {
    expect(
      capabilityCatalog(false, ['fs.read']).find((tool) => tool.id === 'files.read'),
    ).toMatchObject({
      available: false,
      unavailable_reason: expect.stringMatching(/offline/i),
    });
  });
});
