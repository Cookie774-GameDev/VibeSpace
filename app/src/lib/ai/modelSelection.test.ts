import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import {
  applyChatModelSelectionToAgent,
  CHOOSE_MODEL_LABEL,
  EMPTY_CHAT_MODEL_SELECTION,
  formatChatModelSelectionLabel,
  migrateLegacyModelSelection,
  resolveActiveStackPreset,
  selectionFromOption,
  validateChatModelSelection,
  validateSendModelAccess,
} from './modelSelection';
import type { Agent } from '@/types';

const jarvis: Agent = {
  id: 'agent_jarvis' as Agent['id'],
  slug: 'jarvis',
  name: 'Jarvis',
  description: 'Jarvis',
  system_prompt: 'You are Jarvis.',
  model: { provider: 'google', model: 'gemini-2.5-flash-lite' },
  tools_allowed: [],
  memory_scope: 'workspace',
  capabilities: [],
  builtin: true,
  created_at: 1,
  updated_at: 1,
};

describe('modelSelection', () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* jsdom */
    }
    useAuthStore.setState({
      apiKeys: {},
      chatModelSelection: EMPTY_CHAT_MODEL_SELECTION,
      stackPreset: 'off',
      stackCustomSteps: [],
      offlineMode: false,
      defaultLocalModel: 'llama3.2',
      plan: 'free',
    });
  });

  it('shows Choose model when nothing is selected', () => {
    expect(
      formatChatModelSelectionLabel(EMPTY_CHAT_MODEL_SELECTION, {
        apiKeys: {},
        offlineMode: false,
        plan: 'free',
        defaultLocalModel: 'llama3.2',
      }),
    ).toBe(CHOOSE_MODEL_LABEL);
  });

  it('blocks typed send when no model is selected', () => {
    const ctx = { apiKeys: {}, offlineMode: false, plan: 'free' as const, defaultLocalModel: 'llama3.2' };
    const result = validateSendModelAccess('hello', EMPTY_CHAT_MODEL_SELECTION, ctx, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('No model chosen');
    }
  });

  it('blocks voice send when no model is selected', () => {
    const ctx = { apiKeys: {}, offlineMode: false, plan: 'free' as const, defaultLocalModel: 'llama3.2' };
    const result = validateSendModelAccess('hello', EMPTY_CHAT_MODEL_SELECTION, ctx, [], { voice: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('JARVIS voice');
    }
  });

  it('does not treat Hive as default on fresh install', () => {
    expect(migrateLegacyModelSelection({
      stackPreset: 'off',
      defaultProvider: 'google',
      selectedModels: {},
    })).toEqual(EMPTY_CHAT_MODEL_SELECTION);
  });

  it('migrates legacy single-model selection', () => {
    expect(migrateLegacyModelSelection({
      stackPreset: 'off',
      defaultProvider: 'groq',
      selectedModels: { groq: 'llama-3.3-70b-versatile' },
    })).toEqual({
      mode: 'single',
      providerId: 'groq',
      modelId: 'llama-3.3-70b-versatile',
    });
  });

  it('migrates intentional Hive selection', () => {
    expect(migrateLegacyModelSelection({
      stackPreset: 'quality',
      defaultProvider: 'google',
      selectedModels: {},
    })).toEqual({ mode: 'hive', hiveId: 'quality' });
  });

  it('only activates Hive when explicitly selected', () => {
    expect(
      resolveActiveStackPreset(EMPTY_CHAT_MODEL_SELECTION, { matched: false, text: 'hi', preset: undefined, taskType: undefined }),
    ).toBe('off');
    expect(
      resolveActiveStackPreset({ mode: 'hive', hiveId: 'balanced' }, { matched: false, text: 'hi', preset: undefined, taskType: undefined }),
    ).toBe('balanced');
  });

  it('applies user single-model selection to Jarvis at runtime', () => {
    const selection = selectionFromOption('groq', 'llama-3.3-70b-versatile');
    const next = applyChatModelSelectionToAgent(jarvis, selection);
    expect(next.model).toEqual({ provider: 'groq', model: 'llama-3.3-70b-versatile' });
  });

  it('allows send when a connected model is selected', () => {
    const ctx = {
      apiKeys: { groq: 'gsk_test' },
      offlineMode: false,
      plan: 'free' as const,
      defaultLocalModel: 'llama3.2',
    };
    const selection = selectionFromOption('groq', 'llama-3.3-70b-versatile');
    const validation = validateChatModelSelection(selection, ctx, []);
    expect(validation.ok).toBe(true);
    const send = validateSendModelAccess('hello', selection, ctx, []);
    expect(send.ok).toBe(true);
  });
});
