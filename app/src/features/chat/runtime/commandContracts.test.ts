import { describe, expect, it } from 'vitest';
import { parseOpenCodeControlCommand } from './commandContracts';

describe('OpenCode control slash commands', () => {
  it('routes effort and real provider Fast mode to VibeSpace UI authority', () => {
    expect(parseOpenCodeControlCommand('/effort ultra')).toEqual({
      owner: 'vibespace-ui',
      control: 'effort',
      command: { kind: 'effort', value: 'ultra' },
    });
    expect(parseOpenCodeControlCommand('/fast on')).toEqual({
      owner: 'vibespace-ui',
      control: 'fast',
      command: { kind: 'fast', value: 'on' },
    });
  });

  it('assigns RLM commands to context authority', () => {
    expect(parseOpenCodeControlCommand('/rlm refresh')).toEqual({
      owner: 'vibespace-context',
      control: 'rlm',
      command: { kind: 'refresh' },
    });
  });

  it('leaves unrelated user messages untouched', () => {
    expect(parseOpenCodeControlCommand('Please make this fast.')).toBeNull();
  });
});
