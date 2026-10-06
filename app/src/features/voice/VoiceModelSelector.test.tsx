import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_CLI_CONNECTION, OPENCODE_CLI_CONNECTION } from '@/lib/ai/adapters/catalog';
import { selectionFromOption, type ChatModelSelection } from '@/lib/ai/modelSelection';
import type { ModelPickerGroup, ModelPickerOption } from '@/lib/ai/useAccessibleChatModels';
import { VoiceModelSelector } from './VoiceModelSelector';

const setChatModelSelection = vi.fn();
const setVoiceMainAgentProvider = vi.fn();
let storedSelection: ChatModelSelection;
let catalogOverride: {
  groups: ModelPickerGroup[];
  flatOptions: ModelPickerOption[];
  hasAny: boolean;
} | null = null;
beforeEach(() => {
  setChatModelSelection.mockClear();
  setVoiceMainAgentProvider.mockClear();
  storedSelection = {
    mode: 'single',
    providerId: 'openai',
    modelId: 'gpt-5',
    connectionId: 'openai-api',
  } as ChatModelSelection;
  catalogOverride = null;
});

vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({
      chatModelSelection: storedSelection,
      setChatModelSelection,
      setVoiceMainAgentProvider,
    }),
}));

vi.mock('@/lib/ai/useAccessibleChatModels', () => ({
  useAccessibleChatModels: () => {
    if (catalogOverride) return catalogOverride;
    const apiRoute = {
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
    };
    const unavailableApiRoute = {
      id: 'openai-api:gpt-4',
      provider: 'openai',
      modelId: 'gpt-4',
      label: 'GPT-4',
      available: false,
    };
    const baseOpenCodeRoute = {
      id: 'opencode-cli:openai/gpt-5.6-sol',
      provider: 'opencode',
      modelId: 'openai/gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      available: true,
      connection: OPENCODE_CLI_CONNECTION,
      connectionId: OPENCODE_CLI_CONNECTION.id,
      modeLabel: 'Subscription bridge · External agent',
      authLabel: 'Ready',
      catalogSource: 'opencode-live',
    };
    const fastOpenCodeRoute = {
      ...baseOpenCodeRoute,
      id: 'opencode-cli:openai/gpt-5.6-sol-fast',
      modelId: 'openai/gpt-5.6-sol-fast',
      label: 'GPT-5.6 Sol Fast',
    };

    return {
      groups: [
        {
          id: 'connection:openai-api',
          provider: 'openai',
          label: 'OpenAI API',
          options: [apiRoute, unavailableApiRoute],
        },
        {
          id: 'opencode:openai-subscription',
          provider: 'opencode',
          label: 'OpenAI Subscription',
          options: [
            {
              ...baseOpenCodeRoute,
              alternativeRoutes: [baseOpenCodeRoute, fastOpenCodeRoute],
            },
          ],
        },
      ],
      flatOptions: [apiRoute, unavailableApiRoute, baseOpenCodeRoute, fastOpenCodeRoute],
      hasAny: true,
    };
  },
}));

describe('VoiceModelSelector', () => {
  it('shows connected models and disables unavailable or unsupported voice routes', () => {
    render(<VoiceModelSelector />);

    expect(screen.getByText('Model')).toBeTruthy();
    expect(screen.getByText('OpenAI API')).toBeTruthy();

    const selector = screen.getByRole('combobox', {
      name: 'Jarvis voice model',
    }) as HTMLSelectElement;
    expect(selector.value).toBe('openai-api:gpt-5');
    expect((screen.getByRole('option', { name: /GPT-4/ }) as HTMLOptionElement).disabled).toBe(
      true,
    );

    fireEvent.change(selector, { target: { value: 'openai-api:gpt-5' } });
    expect(
      (
        screen.getByRole('option', {
          name: /^GPT-5 — unavailable for Jarvis voice$/,
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);
    expect(setChatModelSelection).not.toHaveBeenCalled();
  });

  it('expands grouped exact routes and persists the selected alternate identity untouched', () => {
    setChatModelSelection.mockClear();
    render(<VoiceModelSelector />);

    const selector = screen.getByRole('combobox', {
      name: 'Jarvis voice model',
    }) as HTMLSelectElement;
    expect((screen.getByRole('option', { name: 'GPT-5.6 Sol' }) as HTMLOptionElement).value).toBe(
      'opencode-cli:openai/gpt-5.6-sol',
    );
    expect(
      (screen.getByRole('option', { name: 'GPT-5.6 Sol Fast' }) as HTMLOptionElement).value,
    ).toBe('opencode-cli:openai/gpt-5.6-sol-fast');

    fireEvent.change(selector, {
      target: { value: 'opencode-cli:openai/gpt-5.6-sol-fast' },
    });
    expect(setChatModelSelection).toHaveBeenCalledWith({
      mode: 'single',
      providerId: 'opencode',
      modelId: 'openai/gpt-5.6-sol-fast',
      connectionId: OPENCODE_CLI_CONNECTION.id,
      connectionMode: OPENCODE_CLI_CONNECTION.mode,
      authSource: OPENCODE_CLI_CONNECTION.authSource,
      capabilities: OPENCODE_CLI_CONNECTION.capabilities,
    });
    expect(setVoiceMainAgentProvider).toHaveBeenCalledWith('opencode');
  });

  it('keeps an unknown connection distinct from the same model on another route', () => {
    const route: ModelPickerOption = {
      id: 'codex-cli:gpt-5',
      provider: 'openai',
      modelId: 'gpt-5',
      label: 'Codex GPT-5',
      available: true,
      connection: CODEX_CLI_CONNECTION,
      connectionId: CODEX_CLI_CONNECTION.id,
    };
    catalogOverride = {
      groups: [{ id: 'native', provider: 'openai', label: 'Codex', options: [route] }],
      flatOptions: [route],
      hasAny: true,
    };
    storedSelection = {
      ...selectionFromOption('openai', 'gpt-5', CODEX_CLI_CONNECTION),
      connectionId: 'missing-connection',
    } as ChatModelSelection;
    render(<VoiceModelSelector />);
    expect((screen.getByLabelText('Jarvis voice model') as HTMLSelectElement).value).toBe('');
  });

  it('disables a cloud-only route instead of persisting a choice the voice Main harness cannot send', () => {
    const cloud: ModelPickerOption = {
      id: 'cloud-only',
      provider: 'groq',
      modelId: 'cloud-model',
      label: 'Cloud-only model',
      available: true,
    };
    catalogOverride = {
      groups: [{ id: 'cloud', provider: 'groq', label: 'Cloud', options: [cloud] }],
      flatOptions: [cloud],
      hasAny: true,
    };
    render(<VoiceModelSelector />);
    expect(
      (screen.getByRole('option', { name: /Cloud-only model/ }) as HTMLOptionElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText('Jarvis voice model'), { target: { value: cloud.id } });
    expect(setChatModelSelection).not.toHaveBeenCalled();
    expect(setVoiceMainAgentProvider).not.toHaveBeenCalled();
  });
});
