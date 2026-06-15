import { describe, expect, it } from 'vitest';
import {
  classifyStackTask,
  effectiveStackPreset,
  parseStackSlashCommand,
} from './classifier';

describe('Hive classifier', () => {
  it('classifies review before code and research before general', () => {
    expect(classifyStackTask('please review this TypeScript fix')).toBe('review');
    expect(classifyStackTask('research and cite the options')).toBe('research');
    expect(classifyStackTask('write a launch email')).toBe('write');
    expect(classifyStackTask('hello there')).toBe('general');
  });

  it('parses /Hive as the Hive slash command', () => {
    expect(parseStackSlashCommand('/Hive quality code fix auth')).toEqual({
      matched: true,
      preset: 'quality',
      taskType: 'code',
      text: 'fix auth',
    });
    expect(parseStackSlashCommand('/VibeHive quality code fix auth')).toMatchObject({
      matched: false,
    });
  });

  it('parses /hive and /stack aliases', () => {
    expect(parseStackSlashCommand('/Hive quality explain the release')).toMatchObject({
      matched: true,
      preset: 'quality',
      text: 'explain the release',
    });
    expect(parseStackSlashCommand('/hive high research compare models')).toMatchObject({
      matched: true,
      preset: 'high',
      taskType: 'research',
      text: 'compare models',
    });
    expect(parseStackSlashCommand('/stack balanced write landing copy')).toMatchObject({
      matched: true,
      preset: 'balanced',
      taskType: 'write',
      text: 'landing copy',
    });
  });

  it('keeps stored preset unless slash selects a non-off preset', () => {
    expect(effectiveStackPreset('balanced', undefined)).toBe('balanced');
    expect(effectiveStackPreset('balanced', 'off')).toBe('off');
    expect(effectiveStackPreset('balanced', 'quality')).toBe('quality');
  });
});
