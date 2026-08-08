import { describe, expect, it } from 'vitest';
import {
  askAssistantAboutLabel,
  askAssistantLabel,
  assistantPersonaDisplayName,
  DEFAULT_ASSISTANT_PERSONA,
  normalizeAssistantPersonaId,
} from './assistantPersona';

describe('assistantPersona', () => {
  it('defaults to Jarvis and only accepts jarvis|friday', () => {
    expect(DEFAULT_ASSISTANT_PERSONA).toBe('jarvis');
    expect(normalizeAssistantPersonaId(undefined)).toBe('jarvis');
    expect(normalizeAssistantPersonaId('friday')).toBe('friday');
    expect(normalizeAssistantPersonaId('Friday')).toBe('friday');
    expect(normalizeAssistantPersonaId('athena')).toBe('jarvis');
    expect(normalizeAssistantPersonaId('sage')).toBe('jarvis');
    expect(normalizeAssistantPersonaId('unknown')).toBe('jarvis');
  });

  it('exposes only Jarvis/Friday display names', () => {
    expect(assistantPersonaDisplayName('jarvis')).toBe('Jarvis');
    expect(assistantPersonaDisplayName('friday')).toBe('Friday');
    expect(assistantPersonaDisplayName('sage')).toBe('Jarvis');
    expect(askAssistantLabel('friday')).toBe('Ask Friday');
    expect(askAssistantAboutLabel('this selection', 'jarvis')).toBe(
      'Ask Jarvis about this selection',
    );
  });
});
