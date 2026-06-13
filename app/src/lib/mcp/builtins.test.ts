import { describe, expect, it } from 'vitest';
import { toolRegistry } from './index';

describe('built-in MCP tools', () => {
  it('does not register removed clock tools', async () => {
    await expect(toolRegistry.invoke('clock.timer', {})).rejects.toThrow(/not registered/);
  });
});
