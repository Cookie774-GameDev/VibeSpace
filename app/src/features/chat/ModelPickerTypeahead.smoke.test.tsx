import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderConnection } from '@/lib/ai/adapters/types';
import { ModelPickerTypeahead, type ModelPickerTypeaheadRef } from './ModelPickerTypeahead';

const capabilities = {
  text: true,
  images: false,
  files: false,
  tools: false,
  modelSelection: true,
  structuredOutput: true,
  streaming: true,
  cancellation: true,
  resumeSession: false,
  systemPrompt: true,
  workingDirectory: false,
  usage: true,
  subscriptionQuota: false,
  localOnly: true,
};

function connection(id: string, mode: ProviderConnection['mode']): ProviderConnection {
  return {
    id,
    adapterId: id,
    providerId: 'vibespace-kernel-smoke',
    displayName: id,
    mode,
    authSource: 'debug-native-attestation',
    capabilities,
    promptTransport: mode === 'external-cli' ? 'prefixed-preamble' : 'native-system',
    enabled: true,
  };
}

describe('ModelPickerTypeahead smoke transports', () => {
  it('exposes the popup, provider groups, and model choices with truthful selection semantics', () => {
    const openCode = connection('opencode-cli', 'external-cli');
    const ref = createRef<ModelPickerTypeaheadRef>();
    let highlightedId = 'opencode-cli:deepseek-v4-flash';
    const groups = [
      {
        id: 'provider:opencode',
        provider: 'opencode' as never,
        label: 'OpenCode Models',
        options: [
          {
            id: 'opencode-cli:deepseek-v4-flash',
            provider: 'opencode' as never,
            modelId: 'deepseek-v4-flash',
            label: 'DeepSeek V4 Flash',
            connection: openCode,
            available: true,
          },
          {
            id: 'opencode-cli:gpt-fast',
            provider: 'opencode' as never,
            modelId: 'gpt-fast',
            label: 'GPT Fast',
            connection: openCode,
            available: true,
          },
          {
            id: 'opencode-cli:offline-model',
            provider: 'opencode' as never,
            modelId: 'offline-model',
            label: 'Offline model',
            connection: openCode,
            available: false,
          },
        ],
      },
    ];
    const picker = () => (
      <ModelPickerTypeahead
        ref={ref}
        groups={groups}
        selectedId={highlightedId}
        activeProvider={'opencode' as never}
        activeModel="deepseek-v4-flash"
        onHoverId={(id) => {
          highlightedId = id;
        }}
        onSelect={vi.fn()}
      />
    );
    const { rerender } = render(picker());

    expect(screen.getByRole('dialog', { name: 'Choose AI model' })).not.toBeNull();
    const listbox = screen.getByRole('listbox', { name: 'Available AI models' });
    const searchbox = screen.getByRole('searchbox', { name: 'Search providers and models' });
    expect(listbox.id).toBeTruthy();
    expect(searchbox.getAttribute('aria-controls')).toBe(listbox.id);
    expect(searchbox.getAttribute('aria-expanded')).toBe('true');
    const initialActiveDescendant = listbox.getAttribute('aria-activedescendant');
    expect(initialActiveDescendant).toBeTruthy();
    expect(document.getElementById(initialActiveDescendant!)).not.toBeNull();
    expect(searchbox.getAttribute('aria-activedescendant')).toBe(initialActiveDescendant);
    expect(
      Array.from(document.querySelectorAll('[id]')).filter(
        (element) => element.id === initialActiveDescendant,
      ),
    ).toHaveLength(1);
    const heading = screen.getByRole('button', { name: 'Collapse OpenCode Models' });
    const providerGroup = screen.getByRole('group', { name: 'OpenCode Models models' });
    expect(heading.getAttribute('aria-controls')).toBe(providerGroup.id);
    expect(
      screen.getByRole('option', { name: /DeepSeek V4 Flash/i }).getAttribute('aria-selected'),
    ).toBe('true');
    const unavailable = screen.getByRole('option', { name: /Offline model/i });
    expect(unavailable.getAttribute('aria-selected')).toBe('false');
    expect(unavailable.getAttribute('aria-disabled')).toBe('true');

    act(() => ref.current?.moveDown());
    rerender(picker());
    const movedActiveDescendant = listbox.getAttribute('aria-activedescendant');
    expect(movedActiveDescendant).not.toBe(initialActiveDescendant);
    expect(document.getElementById(movedActiveDescendant!)).not.toBeNull();
    expect(searchbox.getAttribute('aria-activedescendant')).toBe(movedActiveDescendant);
    expect(
      screen.getByRole('option', { name: /DeepSeek V4 Flash/i }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByRole('option', { name: /GPT Fast/i }).getAttribute('aria-selected')).toBe(
      'false',
    );
    fireEvent.change(searchbox, { target: { value: 'GPT' } });
    expect(
      document.getElementById(searchbox.getAttribute('aria-activedescendant')!),
    ).not.toBeNull();
  });

  it('mounts the native catalog visibly without waiting for a background animation frame', () => {
    const { container } = render(
      <ModelPickerTypeahead groups={[]} selectedId="" onSelect={vi.fn()} />,
    );

    const surface = container.querySelector<HTMLElement>('.jarvis-slash-dropdown');
    expect(surface).not.toBeNull();
    expect(surface?.style.opacity).not.toBe('0');
  });

  it('immediately hides and disables a retained closed picker while restoring trigger focus', async () => {
    const { rerender } = render(
      <>
        <button type="button" aria-controls="retained-picker-content">
          Choose model
        </button>
        <div id="retained-picker-content" data-state="open">
          <ModelPickerTypeahead groups={[]} selectedId="" onSelect={vi.fn()} />
        </div>
      </>,
    );

    const trigger = screen.getByRole('button', { name: 'Choose model' });
    const content = document.getElementById('retained-picker-content')!;
    const picker = screen.getByRole('dialog', { name: 'Choose AI model' });
    content.setAttribute('data-state', 'closed');

    await waitFor(() => expect(picker.getAttribute('data-exit-closed')).toBe('true'));
    expect(picker.hasAttribute('inert')).toBe(true);
    expect(picker.getAttribute('aria-hidden')).toBe('true');
    expect(content.getAttribute('data-model-picker-exit-closed')).toBe('true');
    expect(content.hasAttribute('inert')).toBe(true);
    expect(content.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(trigger);

    content.setAttribute('data-state', 'open');
    await waitFor(() => expect(picker.hasAttribute('data-exit-closed')).toBe(false));
    expect(content.hasAttribute('data-model-picker-exit-closed')).toBe(false);
    expect(content.hasAttribute('inert')).toBe(false);
    expect(content.hasAttribute('aria-hidden')).toBe(false);

    content.setAttribute('data-state', 'closed');
    await waitFor(() => expect(content.hasAttribute('inert')).toBe(true));
    rerender(
      <>
        <button type="button" aria-controls="retained-picker-content">
          Choose model
        </button>
        <div id="retained-picker-content" data-state="closed" />
      </>,
    );
    expect(content.hasAttribute('data-model-picker-exit-closed')).toBe(false);
    expect(content.hasAttribute('inert')).toBe(false);
    expect(content.hasAttribute('aria-hidden')).toBe(false);
  });

  it('shows truthful live free pricing without disabling selection', () => {
    const openCode = connection('opencode-cli', 'external-cli');
    const onSelect = vi.fn();
    const { container } = render(
      <ModelPickerTypeahead
        groups={[
          {
            provider: 'opencode' as never,
            label: 'OpenCode Models',
            options: [
              {
                id: 'opencode-cli:openai/gpt-free',
                provider: 'opencode' as never,
                modelId: 'openai/gpt-free',
                label: 'GPT Free',
                connection: openCode,
                available: true,
                pricingStatus: 'free',
                isFree: true,
              },
            ],
          },
        ]}
        selectedId="opencode-cli:openai/gpt-free"
        onSelect={onSelect}
      />,
    );

    expect(screen.getByText('OpenCode Models')).not.toBeNull();
    expect(screen.getByText('Free')).not.toBeNull();
    const option = container.querySelector('[data-model-price="free"]');
    expect(option).not.toBeNull();
    fireEvent.click(option!);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: /auto/i }));
    expect(onSelect).toHaveBeenCalledWith('opencode', 'openai/gpt-free', openCode, 'auto');
  });

  it('exposes and selects each exact real connection through its closed control', () => {
    const native = connection('vibespace-kernel-smoke-native', 'native-api');
    const cli = connection('vibespace-kernel-smoke-cli', 'external-cli');
    const onSelect = vi.fn();
    const { container } = render(
      <ModelPickerTypeahead
        groups={[
          {
            provider: 'vibespace-kernel-smoke' as never,
            label: 'VibeSpace Kernel Smoke',
            options: [
              {
                id: `${native.id}:kernel-smoke-v1`,
                provider: 'vibespace-kernel-smoke' as never,
                modelId: 'kernel-smoke-v1',
                label: 'Kernel Smoke v1',
                connection: native,
              },
              {
                id: `${cli.id}:kernel-smoke-v1`,
                provider: 'vibespace-kernel-smoke' as never,
                modelId: 'kernel-smoke-v1',
                label: 'Kernel Smoke v1',
                connection: cli,
              },
            ],
          },
        ]}
        selectedId={`${native.id}:kernel-smoke-v1`}
        onSelect={onSelect}
      />,
    );

    const nativeControl = container.querySelector('[data-sik-evidence="model.transport-native"]');
    const cliControl = container.querySelector('[data-sik-evidence="model.transport-cli"]');
    const surface = container.querySelector<HTMLElement>('.jarvis-slash-dropdown');
    expect(nativeControl).not.toBeNull();
    expect(cliControl).not.toBeNull();
    expect(surface).not.toBeNull();
    expect(surface?.className).toContain('[html[data-theme=monochrome]_&]:shadow-none');
    expect(surface?.className).toContain('[html[data-theme=monochrome]_&]:backdrop-blur-none');
    expect(surface?.className).toContain('[html[data-theme=monochrome]_&_*]:bg-none');
    expect(surface?.className).toContain('[html[data-theme=monochrome]_&_*]:shadow-none');
    fireEvent.click(cliControl!);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: /auto/i }));
    expect(onSelect).toHaveBeenCalledWith('vibespace-kernel-smoke', 'kernel-smoke-v1', cli, 'auto');
  });

  it('renders one logical row but lets the exact Fast route and Max effort be selected', () => {
    const openCode = {
      ...connection('opencode-cli', 'external-cli'),
      adapterId: 'opencode-cli',
      providerId: 'opencode',
      displayName: 'OpenCode Bridge',
    };
    const onSelect = vi.fn();
    render(
      <ModelPickerTypeahead
        groups={[
          {
            provider: 'opencode' as never,
            label: 'OpenCode Models',
            options: [
              {
                id: 'opencode-cli:qwen/qwen3.7-plus',
                provider: 'opencode' as never,
                modelId: 'qwen/qwen3.7-plus',
                label: 'Qwen 3.7 Plus',
                connection: openCode,
                available: true,
                alternativeRoutes: [
                  {
                    id: 'opencode-cli:qwen/qwen3.7-plus',
                    provider: 'opencode' as never,
                    modelId: 'qwen/qwen3.7-plus',
                    label: 'Qwen 3.7 Plus',
                    connection: openCode,
                    modeLabel: 'OpenCode Bridge',
                    available: true,
                  },
                  {
                    id: 'opencode-cli:qwen/qwen3.7-plus-fast',
                    provider: 'opencode' as never,
                    modelId: 'qwen/qwen3.7-plus-fast',
                    label: 'Qwen 3.7 Plus',
                    connection: openCode,
                    modeLabel: 'OpenCode Bridge',
                    available: true,
                    variants: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
                  },
                ],
              },
            ],
          },
        ]}
        selectedId="opencode-cli:qwen/qwen3.7-plus"
        onSelect={onSelect}
      />,
    );

    expect(screen.getAllByText('Qwen 3.7 Plus')).toHaveLength(1);
    expect(screen.queryByRole('group', { name: 'Qwen 3.7 Plus routes' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Codex \/ ChatGPT subscription/i })).toBeNull();
    fireEvent.click(screen.getByText('Qwen 3.7 Plus'));
    expect(onSelect).not.toHaveBeenCalled();
    const routes = screen.getByRole('group', { name: 'Qwen 3.7 Plus routes' });
    expect(within(routes).getByText(/qwen\/qwen3\.7-plus-fast/i)).not.toBeNull();
    fireEvent.click(within(routes).getByRole('option', { name: /qwen\/qwen3\.7-plus-fast/i }));
    fireEvent.click(screen.getByRole('option', { name: 'max' }));
    expect(onSelect).toHaveBeenCalledWith('opencode', 'qwen/qwen3.7-plus-fast', openCode, 'max');
  });

  it('preserves an exact selected alias when keyboard activation repeats the current row', () => {
    const openCode = {
      ...connection('opencode-cli', 'external-cli'),
      adapterId: 'opencode-cli',
      providerId: 'opencode',
      displayName: 'OpenCode Bridge',
    };
    const ref = createRef<ModelPickerTypeaheadRef>();
    const onSelect = vi.fn();
    render(
      <ModelPickerTypeahead
        ref={ref}
        groups={[
          {
            provider: 'opencode' as never,
            label: 'OpenCode Models',
            options: [
              {
                id: 'opencode-cli:openai/gpt-5.6-sol',
                provider: 'opencode' as never,
                modelId: 'openai/gpt-5.6-sol',
                label: 'GPT-5.6 Sol',
                connection: openCode,
                available: true,
                alternativeRoutes: [
                  {
                    id: 'opencode-cli:openai/gpt-5.6-sol',
                    provider: 'opencode' as never,
                    modelId: 'openai/gpt-5.6-sol',
                    label: 'GPT-5.6 Sol · OpenAI',
                    connection: openCode,
                    available: true,
                  },
                  {
                    id: 'opencode-cli:openrouter/openai/gpt-5.6-sol',
                    provider: 'opencode' as never,
                    modelId: 'openrouter/openai/gpt-5.6-sol',
                    label: 'GPT-5.6 Sol · OpenRouter',
                    connection: openCode,
                    available: true,
                  },
                ],
              },
            ],
          },
        ]}
        selectedId="opencode-cli:openrouter/openai/gpt-5.6-sol"
        onSelect={onSelect}
      />,
    );

    expect(screen.queryByRole('group', { name: 'GPT-5.6 Sol routes' })).toBeNull();
    act(() => ref.current?.selectCurrent());
    expect(onSelect).not.toHaveBeenCalled();
    act(() => ref.current?.selectCurrent());
    expect(onSelect).toHaveBeenCalledWith(
      'opencode',
      'openrouter/openai/gpt-5.6-sol',
      openCode,
      'auto',
    );
  });

  it('keeps an unavailable exact route disabled and supports keyboard route selection', () => {
    const openCode = connection('opencode-cli', 'external-cli');
    const ref = createRef<ModelPickerTypeaheadRef>();
    const onSelect = vi.fn();
    const { rerender } = render(
      <ModelPickerTypeahead
        ref={ref}
        groups={[
          {
            provider: 'opencode' as never,
            label: 'OpenCode Models',
            options: [
              {
                id: 'opencode-cli:openai/gpt-5.6-luna',
                provider: 'opencode' as never,
                modelId: 'openai/gpt-5.6-luna',
                label: 'GPT-5.6 Luna',
                connection: openCode,
                available: true,
                alternativeRoutes: [
                  {
                    id: 'opencode-cli:openai/gpt-5.6-luna',
                    provider: 'opencode' as never,
                    modelId: 'openai/gpt-5.6-luna',
                    label: 'GPT-5.6 Luna',
                    connection: openCode,
                    available: true,
                  },
                  {
                    id: 'opencode-cli:openai/gpt-5.6-luna-fast',
                    provider: 'opencode' as never,
                    modelId: 'openai/gpt-5.6-luna-fast',
                    label: 'GPT-5.6 Luna',
                    connection: openCode,
                    available: false,
                    variants: ['max'],
                  },
                ],
              },
            ],
          },
        ]}
        selectedId="opencode-cli:openai/gpt-5.6-luna"
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByText('GPT-5.6 Luna'));
    const unavailable = screen.getByRole('option', { name: /gpt-5\.6-luna-fast/i });
    expect(unavailable.hasAttribute('disabled')).toBe(true);
    fireEvent.click(unavailable);
    expect(screen.queryByText('Choose effort')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    act(() => ref.current?.cancelPending());

    rerender(
      <ModelPickerTypeahead
        ref={ref}
        groups={[
          {
            provider: 'opencode' as never,
            label: 'OpenCode Models',
            options: [
              {
                id: 'opencode-cli:openai/gpt-5.6-luna',
                provider: 'opencode' as never,
                modelId: 'openai/gpt-5.6-luna',
                label: 'GPT-5.6 Luna',
                connection: openCode,
                available: true,
                alternativeRoutes: [
                  {
                    id: 'opencode-cli:openai/gpt-5.6-luna',
                    provider: 'opencode' as never,
                    modelId: 'openai/gpt-5.6-luna',
                    label: 'GPT-5.6 Luna',
                    connection: openCode,
                    available: true,
                  },
                  {
                    id: 'opencode-cli:openai/gpt-5.6-luna-fast',
                    provider: 'opencode' as never,
                    modelId: 'openai/gpt-5.6-luna-fast',
                    label: 'GPT-5.6 Luna',
                    connection: openCode,
                    available: true,
                    variants: ['max'],
                  },
                ],
              },
            ],
          },
        ]}
        selectedId="opencode-cli:openai/gpt-5.6-luna"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByText('GPT-5.6 Luna'));
    const routeListbox = screen.getByRole('listbox', { name: 'GPT-5.6 Luna route options' });
    expect(screen.getByText('Fast')).toBeTruthy();
    expect(screen.getByText('Standard')).toBeTruthy();
    expect(screen.getByRole('option', { name: /Fast.*luna-fast/i }).getAttribute('data-model-route-fast')).toBe('true');
    const initialRouteDescendant = routeListbox.getAttribute('aria-activedescendant');
    expect(document.getElementById(initialRouteDescendant!)).not.toBeNull();
    act(() => ref.current?.moveDown());
    const movedRouteDescendant = routeListbox.getAttribute('aria-activedescendant');
    expect(movedRouteDescendant).not.toBe(initialRouteDescendant);
    expect(document.getElementById(movedRouteDescendant!)).not.toBeNull();
    expect(
      screen.getByRole('option', { name: /openai\/gpt-5\.6-luna$/i }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      screen
        .getByRole('option', { name: /openai\/gpt-5\.6-luna-fast/i })
        .getAttribute('aria-selected'),
    ).toBe('false');
    act(() => ref.current?.selectCurrent());
    const effortListbox = screen.getByRole('listbox', { name: 'GPT-5.6 Luna effort options' });
    const initialEffortDescendant = effortListbox.getAttribute('aria-activedescendant');
    expect(document.getElementById(initialEffortDescendant!)).not.toBeNull();
    act(() => ref.current?.moveDown());
    const movedEffortDescendant = effortListbox.getAttribute('aria-activedescendant');
    expect(movedEffortDescendant).not.toBe(initialEffortDescendant);
    expect(document.getElementById(movedEffortDescendant!)).not.toBeNull();
    expect(screen.getByRole('option', { name: /auto/i }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('option', { name: 'max' }).getAttribute('aria-selected')).toBe('false');
    fireEvent.click(screen.getByRole('option', { name: 'max' }));
    expect(onSelect).toHaveBeenCalledWith('opencode', 'openai/gpt-5.6-luna-fast', openCode, 'max');
  });

  it('commits the exact route and only a genuinely supported effort on the second Enter', () => {
    const openCode = {
      ...connection('opencode-cli', 'external-cli'),
      adapterId: 'opencode-cli',
      providerId: 'opencode',
      displayName: 'OpenCode Bridge',
    };
    const ref = createRef<ModelPickerTypeaheadRef>();
    const onSelect = vi.fn();
    render(
      <ModelPickerTypeahead
        ref={ref}
        groups={[
          {
            provider: 'opencode' as never,
            label: 'OpenCode Models',
            options: [
              {
                id: 'opencode-cli:openrouter/openai/gpt-5.6-sol',
                provider: 'opencode' as never,
                modelId: 'openrouter/openai/gpt-5.6-sol',
                label: 'GPT-5.6 Sol',
                connection: openCode,
                available: true,
                variants: ['medium'],
              },
            ],
          },
        ]}
        selectedId="opencode-cli:openrouter/openai/gpt-5.6-sol"
        onSelect={onSelect}
      />,
    );

    const selectedModel = document.querySelector(
      '[data-value="opencode-cli:openrouter/openai/gpt-5.6-sol"]',
    );
    expect(selectedModel).not.toBeNull();
    act(() => ref.current?.selectCurrent());
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('option', { name: /auto/i })).not.toBeNull();
    expect(screen.getByRole('option', { name: 'medium' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'low' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'high' })).toBeNull();
    expect(screen.queryByText(/fast/i)).toBeNull();
    const selectedEffort = screen.getByRole('option', { name: /auto/i });
    expect(selectedModel?.className).toContain('jarvis-slash-item-selected');
    expect(selectedEffort.className).toContain('border-accent-copper/60');
    expect(selectedEffort.className).toContain('jarvis-slash-item-selected');
    expect(selectedEffort.querySelector('[data-effort-icon="auto"]')).not.toBeNull();
    act(() => ref.current?.moveDown());
    act(() => ref.current?.selectCurrent());
    expect(onSelect).toHaveBeenCalledWith(
      'opencode',
      'openrouter/openai/gpt-5.6-sol',
      openCode,
      'medium',
    );
  });

  it('contains animated effort glyphs and the Ultra root effect inside its own row', () => {
    render(
      <ModelPickerTypeahead
        groups={[
          {
            provider: 'openai',
            label: 'OpenAI',
            options: [
              {
                id: 'openai-api:gpt-5.6-sol',
                provider: 'openai',
                modelId: 'gpt-5.6-sol',
                label: 'GPT-5.6 Sol',
                connection: connection('openai-api', 'native-api'),
                variants: ['xhigh'],
              },
            ],
          },
        ]}
        selectedId="openai-api:gpt-5.6-sol"
        onSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('GPT-5.6 Sol'));
    expect(document.querySelector('[data-effort-icon="auto"]')).not.toBeNull();
    expect(document.querySelector('[data-effort-icon="ultra"]')).not.toBeNull();
    const ultra = screen.getByRole('option', { name: /xhigh/i });
    expect(ultra.querySelector('[data-ultra-roots="true"]')).not.toBeNull();
    expect(ultra.querySelector('[data-ultra-sigil="true"]')).not.toBeNull();
    expect(ultra.className).toContain('vibespace-effort-row');
    expect(ultra).toBe(document.querySelector('[data-effort-level]:last-child'));
  });

  it('shows exact live Luna effort names, with Max at the bottom', () => {
    render(
      <ModelPickerTypeahead
        groups={[
          {
            provider: 'openai',
            label: 'OpenAI',
            options: [
              {
                id: 'opencode-cli:openai/gpt-5.6-luna',
                provider: 'openai',
                modelId: 'openai/gpt-5.6-luna',
                label: 'GPT-5.6 Luna',
                connection: connection('opencode-cli', 'external-cli'),
                variants: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
              },
            ],
          },
        ]}
        selectedId="opencode-cli:openai/gpt-5.6-luna"
        onSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('GPT-5.6 Luna'));
    const labels = Array.from(document.querySelectorAll('[data-effort-level]')).map((node) =>
      node.getAttribute('data-effort-level'),
    );
    expect(labels).toEqual(['auto', 'minimal', 'low', 'medium', 'high', 'ultra', 'max']);
    expect(screen.getByRole('option', { name: /^none$/i })).toBeTruthy();
    expect(screen.getByRole('option', { name: /^xhigh$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /ultra/i })).toBeNull();
  });

  it('cancels a pending model without changing the committed selection', () => {
    const openCode = connection('opencode-cli', 'external-cli');
    const ref = createRef<ModelPickerTypeaheadRef>();
    const onSelect = vi.fn();
    render(
      <ModelPickerTypeahead
        ref={ref}
        groups={[
          {
            provider: 'opencode' as never,
            label: 'OpenCode Models',
            options: [
              {
                id: 'opencode-cli:openai/gpt-5.6-terra',
                provider: 'opencode' as never,
                modelId: 'openai/gpt-5.6-terra',
                label: 'GPT-5.6 Terra',
                connection: openCode,
                available: true,
                variants: ['low'],
              },
            ],
          },
        ]}
        selectedId="opencode-cli:openai/gpt-5.6-terra"
        onSelect={onSelect}
      />,
    );

    act(() => ref.current?.selectCurrent());
    expect(screen.getByText('Choose effort')).not.toBeNull();
    act(() => ref.current?.cancelPending());
    expect(screen.queryByText('Choose effort')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('restores a supported saved effort and falls back to Auto when unsupported', () => {
    const openCode = connection('opencode-cli', 'external-cli');
    const onSelect = vi.fn();
    const { unmount } = render(
      <ModelPickerTypeahead
        groups={[
          {
            provider: 'opencode' as never,
            label: 'OpenCode Models',
            options: [
              {
                id: 'opencode-cli:openai/gpt-5.6-sol',
                provider: 'opencode' as never,
                modelId: 'openai/gpt-5.6-sol',
                label: 'GPT-5.6 Sol',
                connection: openCode,
                variants: ['medium'],
              },
            ],
          },
        ]}
        selectedId="opencode-cli:openai/gpt-5.6-sol"
        initialEffort="medium"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByText('GPT-5.6 Sol'));
    expect(screen.getByRole('option', { name: 'medium' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    unmount();
    render(
      <ModelPickerTypeahead
        groups={[
          {
            provider: 'opencode' as never,
            label: 'OpenCode Models',
            options: [
              {
                id: 'opencode-cli:openai/gpt-5.6-terra',
                provider: 'opencode' as never,
                modelId: 'openai/gpt-5.6-terra',
                label: 'GPT-5.6 Terra',
                connection: openCode,
                variants: ['low'],
              },
            ],
          },
        ]}
        selectedId="opencode-cli:openai/gpt-5.6-terra"
        initialEffort="medium"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByText('GPT-5.6 Terra'));
    expect(screen.getByRole('option', { name: /auto/i }).getAttribute('aria-pressed')).toBe('true');
  });

  it('independently collapses and expands every provider heading', () => {
    const onSelect = vi.fn();
    render(
      <ModelPickerTypeahead
        groups={[
          {
            id: 'provider:openai',
            provider: 'openai',
            label: 'OpenAI',
            options: [
              {
                id: 'openai-api:gpt-5.6',
                provider: 'openai',
                modelId: 'gpt-5.6',
                label: 'GPT-5.6',
                connection: connection('openai-api', 'native-api'),
              },
            ],
          },
          {
            id: 'provider:alibaba',
            provider: 'opencode' as never,
            label: 'Alibaba',
            options: [
              {
                id: 'opencode-cli:alibaba/qwen3.7-plus',
                provider: 'opencode' as never,
                modelId: 'alibaba/qwen3.7-plus',
                label: 'Qwen 3.7 Plus',
                connection: connection('opencode-cli', 'external-cli'),
              },
            ],
          },
        ]}
        selectedId="openai-api:gpt-5.6"
        onSelect={onSelect}
      />,
    );

    const openAiHeading = screen.getByRole('button', { name: 'Collapse OpenAI' });
    const alibabaHeading = screen.getByRole('button', { name: 'Expand Alibaba' });
    expect(openAiHeading.getAttribute('aria-expanded')).toBe('true');
    expect(alibabaHeading.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('GPT-5.6')).not.toBeNull();
    expect(screen.queryByText('Qwen 3.7 Plus')).toBeNull();

    const bubbledKeyDown = vi.fn();
    window.addEventListener('keydown', bubbledKeyDown);
    alibabaHeading.focus();
    fireEvent.keyDown(alibabaHeading, { key: 'Enter' });
    const expandedByEnter = screen.getByRole('button', { name: 'Collapse Alibaba' });
    expandedByEnter.focus();
    fireEvent.keyDown(expandedByEnter, { key: ' ' });
    expect(screen.queryByText('Qwen 3.7 Plus')).toBeNull();
    const collapsedBySpace = screen.getByRole('button', { name: 'Expand Alibaba' });
    collapsedBySpace.focus();
    fireEvent.keyDown(collapsedBySpace, { key: ' ' });
    window.removeEventListener('keydown', bubbledKeyDown);
    expect(bubbledKeyDown).not.toHaveBeenCalled();
    const expandedAlibabaHeading = screen.getByRole('button', { name: 'Collapse Alibaba' });
    expect(screen.getByText('Qwen 3.7 Plus')).not.toBeNull();

    fireEvent.click(openAiHeading);
    const collapsedOpenAiHeading = screen.getByRole('button', { name: 'Expand OpenAI' });
    expect(collapsedOpenAiHeading.getAttribute('aria-expanded')).toBe('false');
    expect(
      document
        .getElementById(collapsedOpenAiHeading.getAttribute('aria-controls')!)
        ?.hasAttribute('hidden'),
    ).toBe(true);
    expect(
      document
        .getElementById(expandedAlibabaHeading.getAttribute('aria-controls')!)
        ?.hasAttribute('hidden'),
    ).toBe(false);
    expect(screen.getByText('Qwen 3.7 Plus')).not.toBeNull();
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Expand OpenAI' }));
    expect(screen.getByRole('button', { name: 'Collapse OpenAI' })).not.toBeNull();
    expect(screen.getByText('GPT-5.6')).not.toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('preserves a collapsed provider across catalog refresh without changing exact selection', () => {
    const onSelect = vi.fn();
    const groups = () => [
      {
        id: 'provider:openai',
        provider: 'openai' as const,
        label: 'OpenAI',
        options: [
          {
            id: 'openai-api:gpt-5.6',
            provider: 'openai' as const,
            modelId: 'gpt-5.6',
            label: 'GPT-5.6',
            connection: connection('openai-api', 'native-api'),
          },
        ],
      },
      {
        id: 'provider:alibaba',
        provider: 'opencode' as never,
        label: 'Alibaba',
        options: [
          {
            id: 'opencode-cli:alibaba/qwen3.7-plus',
            provider: 'opencode' as never,
            modelId: 'alibaba/qwen3.7-plus',
            label: 'Qwen 3.7 Plus',
            connection: connection('opencode-cli', 'external-cli'),
          },
        ],
      },
    ];
    const { rerender } = render(
      <ModelPickerTypeahead
        groups={groups()}
        selectedId="openai-api:gpt-5.6"
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Collapse OpenAI' }));
    expect(screen.getByRole('button', { name: 'Expand OpenAI' })).not.toBeNull();

    rerender(
      <ModelPickerTypeahead
        groups={groups()}
        selectedId="openai-api:gpt-5.6"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole('button', { name: 'Expand OpenAI' })).not.toBeNull();
    expect(onSelect).not.toHaveBeenCalled();

    rerender(
      <ModelPickerTypeahead
        groups={groups()}
        selectedId="opencode-cli:alibaba/qwen3.7-plus"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole('button', { name: 'Collapse Alibaba' })).not.toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps provider groups collapsible while search is active', () => {
    const onSelect = vi.fn();
    render(
      <ModelPickerTypeahead
        groups={[
          {
            id: 'provider:openai',
            provider: 'openai',
            label: 'OpenAI',
            options: [
              {
                id: 'openai-api:gpt-6-luna',
                provider: 'openai',
                modelId: 'gpt-6-luna',
                label: 'GPT-6 Luna',
                connection: connection('openai-api', 'native-api'),
              },
            ],
          },
        ]}
        selectedId=""
        onSelect={onSelect}
      />,
    );

    const search = screen.getByRole('searchbox', { name: 'Search providers and models' });
    fireEvent.change(search, { target: { value: 'Luna 6' } });

    const expandedHeading = screen.getByRole('button', { name: 'Collapse OpenAI' });
    const groupId = expandedHeading.getAttribute('aria-controls')!;
    expect(screen.getByText('GPT-6 Luna')).not.toBeNull();
    fireEvent.click(expandedHeading);

    const collapsedHeading = screen.getByRole('button', { name: 'Expand OpenAI' });
    expect(collapsedHeading.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(groupId)?.hasAttribute('hidden')).toBe(true);
    expect(screen.queryByText('GPT-6 Luna')).toBeNull();

    fireEvent.click(collapsedHeading);
    expect(
      screen.getByRole('button', { name: 'Collapse OpenAI' }).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(document.getElementById(groupId)?.hasAttribute('hidden')).toBe(false);
    expect(screen.getByText('GPT-6 Luna')).not.toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('replaces automatic routing with search across providers, model names, and exact IDs', () => {
    render(
      <ModelPickerTypeahead
        groups={[
          {
            id: 'provider:openai',
            provider: 'openai',
            label: 'OpenAI',
            options: [
              {
                id: 'openai-api:gpt-5.6-sol',
                provider: 'openai',
                modelId: 'gpt-5.6-sol',
                label: 'GPT-5.6 Sol',
                connection: connection('openai-api', 'native-api'),
              },
            ],
          },
          {
            id: 'provider:alibaba',
            provider: 'opencode' as never,
            label: 'Alibaba',
            options: [
              {
                id: 'opencode-cli:alibaba/deepseek-v4-flash-0731',
                provider: 'opencode' as never,
                modelId: 'alibaba/deepseek-v4-flash-0731',
                label: 'DeepSeek V4 Flash 0731',
                connection: connection('opencode-cli', 'external-cli'),
              },
            ],
          },
        ]}
        selectedId=""
        onSelect={vi.fn()}
      />,
    );

    expect(screen.queryByRole('switch', { name: 'Automatic routing' })).toBeNull();
    const search = screen.getByRole('searchbox', { name: 'Search providers and models' });
    expect(search.className).toContain('rounded-2xl');
    const searchSurface = screen.getByRole('search');
    expect(searchSurface.className).toContain('bg-transparent');
    expect(searchSurface.className).not.toContain('bg-panel/90');

    fireEvent.change(search, { target: { value: 'Alibaba' } });
    expect(screen.getByText('DeepSeek V4 Flash 0731')).not.toBeNull();
    expect(screen.queryByText('GPT-5.6 Sol')).toBeNull();

    fireEvent.change(search, { target: { value: 'gpt-5.6-sol' } });
    expect(screen.getByText('GPT-5.6 Sol')).not.toBeNull();
    expect(screen.queryByText('DeepSeek V4 Flash 0731')).toBeNull();

    fireEvent.change(search, { target: { value: 'Alibaba flash' } });
    expect(screen.getByText('DeepSeek V4 Flash 0731')).not.toBeNull();
    expect(screen.queryByText('GPT-5.6 Sol')).toBeNull();

    fireEvent.change(search, { target: { value: 'missing model' } });
    expect(screen.getByText('No matching models.')).not.toBeNull();
  });
});
