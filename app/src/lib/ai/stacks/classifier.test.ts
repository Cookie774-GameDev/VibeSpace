import { describe, it, expect } from 'vitest';
import {
  classifyStackTask,
  parseStackSlashCommand,
  effectiveStackPreset,
} from './classifier';

describe('classifyStackTask', () => {
  it('detects code tasks', () => {
    expect(classifyStackTask('fix this typescript bug')).toBe('code');
  });

  it('detects write tasks', () => {
    expect(classifyStackTask('draft a blog post about AI')).toBe('write');
  });

  it('detects review tasks', () => {
    expect(classifyStackTask('review this PR for security')).toBe('review');
  });

  it('detects research tasks', () => {
    expect(classifyStackTask('research pros and cons of Rust')).toBe('research');
  });

  it('falls back to general', () => {
    expect(classifyStackTask('hello')).toBe('general');
  });
});

describe('parseStackSlashCommand', () => {
  it('parses /hive preset and strips command', () => {
    const r = parseStackSlashCommand('/hive quality write my essay');
    expect(r.preset).toBe('quality');
    expect(r.taskType).toBe('write');
    expect(r.cleanText).toBe('my essay');
  });

  it('parses legacy /stack alias', () => {
    const r = parseStackSlashCommand('/stack quality write my essay');
    expect(r.preset).toBe('quality');
    expect(r.cleanText).toBe('my essay');
  });

  it('returns original text when no slash', () => {
    const r = parseStackSlashCommand('just a question');
    expect(r.preset).toBeUndefined();
    expect(r.cleanText).toBe('just a question');
  });
});

describe('effectiveStackPreset', () => {
  it('prefers slash preset over user setting', () => {
    expect(effectiveStackPreset('fast', 'quality')).toBe('quality');
  });

  it('uses user setting when slash absent', () => {
    expect(effectiveStackPreset('balanced', undefined)).toBe('balanced');
  });
});
