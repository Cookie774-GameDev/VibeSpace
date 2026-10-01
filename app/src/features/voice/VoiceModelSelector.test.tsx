import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatModelSelection } from '@/lib/ai/modelSelection';
import { VoiceModelSelector } from './VoiceModelSelector';

const setChatModelSelection = vi.fn();

vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({
      chatModelSelection: {
        mode: 'single',
        providerId: 'openai',
        modelId: 'gpt-5',
        connectionId: 'openai-api',
      } as ChatModelSelection,
      setChatModelSelection,
    }),
}));

vi.mock('@/lib/ai/useAccessibleChatModels', () => ({
  useAccessibleChatModels: () => ({
    groups: [
      {
        provider: 'openai',
        label: 'OpenAI',
        options: [
          {
            id: 'openai-api:gpt-5',
            provider: 'openai',
            modelId: 'gpt-5',
            label: 'GPT-5',
            available: true,
            connection: {
              id: 'openai-api',
              providerId: 'openai',
              mode: 'native-api',
              authSource: 'api-key',
              capabilities: {},
            },
          },
          {
            id: 'openai-api:gpt-4',
            provider: 'openai',
            modelId: 'gpt-4',
            label: 'GPT-4',
            available: false,
          },
        ],
      },
    ],
    flatOptions: [
      {
        id: 'openai-api:gpt-5',
        provider: 'openai',
        modelId: 'gpt-5',
        label: 'GPT-5',
        available: true,
        connection: {
          id: 'openai-api',
          providerId: 'openai',
          mode: 'native-api',
          authSource: 'api-key',
          capabilities: {},
        },
      },
      {
        id: 'openai-api:gpt-4',
        provider: 'openai',
        modelId: 'gpt-4',
        label: 'GPT-4',
        available: false,
      },
    ],
    hasAny: true,
  }),
}));

describe('VoiceModelSelector', () => {
  it('shows connected models, disables unavailable routes, and persists selection', () => {
    render(<VoiceModelSelector />);

    const selector = screen.getByRole('combobox', {
      name: 'Jarvis voice model',
    }) as HTMLSelectElement;
    expect(selector.value).toBe('openai-api:gpt-5');
    expect((screen.getByRole('option', { name: /GPT-4/ }) as HTMLOptionElement).disabled).toBe(
      true,
    );

    fireEvent.change(selector, { target: { value: 'openai-api:gpt-5' } });
    expect(setChatModelSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'single',
        providerId: 'openai',
        modelId: 'gpt-5',
        connectionId: 'openai-api',
      }),
    );
  });
});
