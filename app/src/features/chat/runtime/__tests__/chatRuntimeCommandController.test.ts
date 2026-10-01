import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAT_RUNTIME_SETTINGS,
  applyChatRuntimeCommand,
  parseChatRuntimeCommand,
} from '../chatRuntimeCommandController';

describe('chat runtime command controller', () => {
  it('explains the context lookup budget and preserved model controls', () => {
    const result = applyChatRuntimeCommand(DEFAULT_CHAT_RUNTIME_SETTINGS, { kind: 'performance', value: 'status' });
    expect(result.kind).toBe('status');
    if (result.kind !== 'status') throw new Error('missing status');
    expect(result.message).toContain('context lookup');
    expect(result.message).toContain('6');
    expect(result.message).toContain('256 KiB');
    expect(result.message).toContain('model, effort');
    expect(result.settings).toEqual(DEFAULT_CHAT_RUNTIME_SETTINGS);
  });
  it('keeps effort, provider Fast mode, performance, and RLM independent', () => {
    let settings = { ...DEFAULT_CHAT_RUNTIME_SETTINGS };
    for (const input of ['/fast on', '/effort high', '/performance responsive', '/rlm off']) {
      const command = parseChatRuntimeCommand(input);
      expect(command).not.toBeNull();
      const result = applyChatRuntimeCommand(settings, command!);
      if (result.kind === 'updated') settings = result.settings;
    }
    expect(settings).toEqual({
      effort: 'high',
      fastMode: 'on',
      performance: 'responsive',
      rlmEnabled: false,
    });
  });

  it('opens pickers without forwarding raw slash commands to the model', () => {
    const command = parseChatRuntimeCommand('/effort');
    expect(command).not.toBeNull();
    expect(applyChatRuntimeCommand(DEFAULT_CHAT_RUNTIME_SETTINGS, command!)).toMatchObject({
      kind: 'picker',
      picker: 'effort',
    });
  });
});
