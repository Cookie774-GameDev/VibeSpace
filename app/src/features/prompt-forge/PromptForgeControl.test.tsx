import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { PromptForgeModelOption } from './modelSelection';
import { PromptForgeControl } from './PromptForgeControl';

const models: readonly PromptForgeModelOption[] = [
  {
    id: 'ollama-local:qwen3:8b',
    providerId: 'ollama',
    modelId: 'qwen3:8b',
    label: 'Qwen 3 8B',
    connectionId: 'ollama-local',
    connectionMode: 'local',
    localOnly: true,
    available: true,
  },
  {
    id: 'openai-codex:gpt-5.6-sol',
    providerId: 'openai',
    modelId: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    connectionId: 'openai-codex',
    connectionMode: 'external-cli',
    localOnly: false,
    available: true,
  },
];

afterEach(() => {
  cleanup();
});

describe('Prompt Forge control', () => {
  it('starts explicitly, stays secondary to Send, and exposes model configuration without lock UI', () => {
    const onStart = vi.fn();
    const onSelectionChange = vi.fn();
    const onPrivacyModeChange = vi.fn();
    render(
      <TooltipProvider>
        <PromptForgeControl
          status="idle"
          statusMessage="Ready to upgrade"
          isRunning={false}
          disabledReason={null}
          error={null}
          compact={false}
          modelSelection={{ mode: 'prefer_local' }}
          modelOptions={models}
          onModelSelectionChange={onSelectionChange}
          privacyMode="local_only"
          onPrivacyModeChange={onPrivacyModeChange}
          allowPublicResearch={false}
          onAllowPublicResearchChange={vi.fn()}
          publicResearchAvailable
          offlineMode={false}
          autoUpgradeOnSend={false}
          onAutoUpgradeOnSendChange={vi.fn()}
          onStart={onStart}
          onCancel={vi.fn()}
        />
      </TooltipProvider>,
    );

    const upgrade = screen.getByRole('button', {
      name: 'Upgrade prompt with Prompt Forge',
    });
    expect(upgrade.getAttribute('data-variant')).toBe('ghost');
    fireEvent.click(upgrade);
    expect(onStart).toHaveBeenCalledOnce();

    const configure = screen.getByRole('button', { name: 'Configure Prompt Forge' });
    expect(configure.className).toContain('min-h-6');
    expect(configure.className).toContain('min-w-6');
    // Lock icon removed — configure uses chevron only.
    expect(configure.querySelector('svg.lucide-lock-keyhole')).toBeNull();
    fireEvent.click(configure);
    expect(screen.getByText('Prompt upgrade model')).toBeTruthy();
    expect(screen.getByText('Upgrade automatically on Send')).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'Prompt Forge privacy' })).toBeNull();
    expect(screen.queryByText('Privacy for this run')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /GPT-5.6 Sol/ }));
    expect(onSelectionChange).toHaveBeenCalledWith({
      mode: 'single',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      connectionId: 'openai-codex',
    });
    expect(onPrivacyModeChange).not.toHaveBeenCalled();
  });

  it('shows a precise disabled reason and turns the active control into Cancel', () => {
    const { rerender } = render(
      <TooltipProvider>
        <PromptForgeControl
          status="idle"
          statusMessage="Ready to upgrade"
          isRunning={false}
          disabledReason="Write or dictate a prompt first."
          error={null}
          compact
          modelSelection={{ mode: 'prefer_local' }}
          modelOptions={models}
          onModelSelectionChange={vi.fn()}
          privacyMode="local_only"
          onPrivacyModeChange={vi.fn()}
          allowPublicResearch={false}
          onAllowPublicResearchChange={vi.fn()}
          publicResearchAvailable
          offlineMode={false}
          autoUpgradeOnSend={false}
          onAutoUpgradeOnSendChange={vi.fn()}
          onStart={vi.fn()}
          onCancel={vi.fn()}
        />
      </TooltipProvider>,
    );
    expect(
      screen
        .getByRole('button', { name: /Upgrade prompt with Prompt Forge/ })
        .getAttribute('aria-description'),
    ).toBe('Write or dictate a prompt first.');

    const onCancel = vi.fn();
    rerender(
      <TooltipProvider>
        <PromptForgeControl
          status="generating"
          statusMessage="Building the upgraded prompt"
          isRunning
          disabledReason="Prompt Forge is already upgrading this draft."
          error={null}
          compact
          modelSelection={{ mode: 'prefer_local' }}
          modelOptions={models}
          onModelSelectionChange={vi.fn()}
          privacyMode="local_only"
          onPrivacyModeChange={vi.fn()}
          allowPublicResearch={false}
          onAllowPublicResearchChange={vi.fn()}
          publicResearchAvailable
          offlineMode={false}
          autoUpgradeOnSend={false}
          onAutoUpgradeOnSendChange={vi.fn()}
          onStart={vi.fn()}
          onCancel={onCancel}
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole('status').textContent).toContain('Building the upgraded prompt');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Prompt Forge upgrade' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('does not expose lock or privacy controls in chat configure menu', () => {
    render(
      <TooltipProvider>
        <PromptForgeControl
          status="idle"
          statusMessage="Ready to upgrade"
          isRunning={false}
          disabledReason={null}
          error={null}
          compact={false}
          modelSelection={{ mode: 'prefer_local' }}
          modelOptions={models}
          onModelSelectionChange={vi.fn()}
          privacyMode="provider_allowed"
          onPrivacyModeChange={vi.fn()}
          allowPublicResearch={false}
          onAllowPublicResearchChange={vi.fn()}
          publicResearchAvailable={false}
          offlineMode={false}
          autoUpgradeOnSend={false}
          onAutoUpgradeOnSendChange={vi.fn()}
          onStart={vi.fn()}
          onCancel={vi.fn()}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Configure Prompt Forge' }));
    expect(screen.queryByRole('checkbox', { name: /Allow public research/i })).toBeNull();
    expect(screen.queryByText(/Privacy for this run/i)).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Prompt Forge privacy' })).toBeNull();
  });
});
