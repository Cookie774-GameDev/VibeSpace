import type { ProviderId } from '@/types';
import { ANTHROPIC_DEFAULT_MODEL } from './providers/anthropic';
import { GOOGLE_DEFAULT_MODEL } from './providers/google';
import { GROQ_DEFAULT_MODEL } from './providers/groq';
import { OLLAMA_DEFAULT_MODEL } from './providers/ollama';
import { OPENAI_DEFAULT_MODEL } from './providers/openai';

export interface ModelOption {
  provider: ProviderId;
  id: string;
  label: string;
}

export const REAL_CHAT_PROVIDERS: readonly ProviderId[] = [
  'google',
  'groq',
  'openai',
  'anthropic',
  'ollama',
  'local',
  'mock',
];

export const CHAT_MODEL_OPTIONS: readonly ModelOption[] = [
  { provider: 'google', id: GOOGLE_DEFAULT_MODEL, label: 'Gemini 2.5 Flash Lite' },
  { provider: 'google', id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { provider: 'google', id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  { provider: 'groq', id: GROQ_DEFAULT_MODEL, label: 'Llama 3.3 70B Versatile' },
  { provider: 'groq', id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant' },
  { provider: 'groq', id: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B' },
  { provider: 'openai', id: OPENAI_DEFAULT_MODEL, label: 'GPT-4o Mini' },
  { provider: 'openai', id: 'gpt-4o', label: 'GPT-4o' },
  { provider: 'openai', id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
  { provider: 'anthropic', id: ANTHROPIC_DEFAULT_MODEL, label: 'Claude 3.5 Sonnet' },
  { provider: 'anthropic', id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
  { provider: 'ollama', id: OLLAMA_DEFAULT_MODEL, label: 'Ollama default' },
  { provider: 'local', id: OLLAMA_DEFAULT_MODEL, label: 'Local default' },
  { provider: 'mock', id: 'mock-default', label: 'Mock demo' },
];

export function getModelOptions(provider: ProviderId): readonly ModelOption[] {
  return CHAT_MODEL_OPTIONS.filter((option) => option.provider === provider);
}

export function defaultModelForProvider(provider: ProviderId, localModel = OLLAMA_DEFAULT_MODEL): string {
  switch (provider) {
    case 'anthropic':
      return ANTHROPIC_DEFAULT_MODEL;
    case 'openai':
      return OPENAI_DEFAULT_MODEL;
    case 'google':
      return GOOGLE_DEFAULT_MODEL;
    case 'groq':
      return GROQ_DEFAULT_MODEL;
    case 'ollama':
    case 'local':
      return localModel || OLLAMA_DEFAULT_MODEL;
    default:
      return 'mock-default';
  }
}

export function isRealChatProvider(provider: ProviderId): boolean {
  return REAL_CHAT_PROVIDERS.includes(provider);
}
