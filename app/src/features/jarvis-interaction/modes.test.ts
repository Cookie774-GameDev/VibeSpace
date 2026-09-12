import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatId } from '@/types/common';
import {
  cycleInteractionMode,
  interactionModeLabel,
  modeFromSlashCommand,
  parsePermissionModeArg,
  PERMISSION_MODE_OPTIONS,
} from './modes';
import { useJarvisInteractionStore } from './sessionStore';

describe('Jarvis interaction modes', () => {
  beforeEach(() => {
    useJarvisInteractionStore.setState(useJarvisInteractionStore.getInitialState());
  });

  it('cycles Agent -> Plan -> Ask -> Agent for Shift+Tab', () => {
    expect(cycleInteractionMode('agent')).toBe('plan');
    expect(cycleInteractionMode('plan')).toBe('ask');
    expect(cycleInteractionMode('ask')).toBe('agent');
  });

  it('maps slash commands to interaction modes', () => {
    expect(modeFromSlashCommand('ask')).toBe('ask');
    expect(modeFromSlashCommand('plan')).toBe('plan');
    expect(modeFromSlashCommand('multitask')).toBe('agent');
    expect(modeFromSlashCommand('permissions agent')).toBe('agent');
    expect(modeFromSlashCommand('permissions plan')).toBe('plan');
    expect(modeFromSlashCommand('permissions ask')).toBe('ask');
    expect(modeFromSlashCommand('permissions full')).toBeNull();
    expect(modeFromSlashCommand('permissions')).toBeNull();
    expect(modeFromSlashCommand('unknown')).toBeNull();
  });

  it('parses /permissions mode arguments without collapsing access levels', () => {
    expect(parsePermissionModeArg('agent')).toBe('agent');
    expect(parsePermissionModeArg('plan')).toBe('plan');
    expect(parsePermissionModeArg('ask')).toBe('ask');
    expect(parsePermissionModeArg('full access')).toBeNull();
    expect(parsePermissionModeArg('read-only')).toBeNull();
    expect(parsePermissionModeArg('write')).toBeNull();
    expect(parsePermissionModeArg('nope')).toBeNull();
  });

  it('exposes three polished mode options with Agent/Plan/Ask labels', () => {
    expect(PERMISSION_MODE_OPTIONS.map((o) => o.id)).toEqual(['agent', 'plan', 'ask']);
    expect(PERMISSION_MODE_OPTIONS.map((o) => o.shortLabel)).toEqual([
      'Agent Mode',
      'Plan Mode',
      'Ask Mode',
    ]);
  });

  it('persists mode per chat with Agent Mode as the default', () => {
    const chatA = 'chat_a' as ChatId;
    const chatB = 'chat_b' as ChatId;

    expect(useJarvisInteractionStore.getState().modeForChat(chatA)).toBe('agent');
    useJarvisInteractionStore.getState().setChatMode(chatA, 'plan');

    expect(useJarvisInteractionStore.getState().modeForChat(chatA)).toBe('plan');
    expect(useJarvisInteractionStore.getState().modeForChat(chatB)).toBe('agent');
  });

  it('exposes user-facing labels for composer chips', () => {
    expect(interactionModeLabel('agent')).toBe('Agent Mode');
    expect(interactionModeLabel('plan')).toBe('Plan Mode');
    expect(interactionModeLabel('ask')).toBe('Ask Mode');
  });
});
