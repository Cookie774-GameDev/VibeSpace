import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PromptForgeControl } from './PromptForgeControl';

const controlSource = readFileSync(resolve(__dirname, 'PromptForgeControl.tsx'), 'utf8');
const recoverySource = readFileSync(resolve(__dirname, 'PromptForgeRecovery.tsx'), 'utf8');
const reviewSource = readFileSync(resolve(__dirname, 'PromptForgeReview.tsx'), 'utf8');
const cssPath = resolve(__dirname, 'sakura-prompt-forge.css');
const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';

describe('Prompt Forge Sakura appearance', () => {
  it('adds presentation hooks without changing explicit start or configuration behavior', () => {
    const onStart = vi.fn();
    const onModelSelectionChange = vi.fn();
    const onPrivacyModeChange = vi.fn();
    const rendered = render(
      <TooltipProvider>
        <PromptForgeControl
          status="idle"
          statusMessage="Ready to upgrade"
          isRunning={false}
          disabledReason={null}
          error={null}
          compact={false}
          modelSelection={{ mode: 'prefer_local' }}
          modelOptions={[]}
          onModelSelectionChange={onModelSelectionChange}
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

    expect(rendered.container.querySelector('[data-sakura-surface="prompt-forge"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade prompt with Prompt Forge' }));
    expect(onStart).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Configure Prompt Forge' }));
    expect(document.querySelector('[data-sakura-surface="prompt-forge-settings"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Use current chat model/ }));
    expect(onModelSelectionChange).toHaveBeenCalledWith({ mode: 'current_chat_model' });
    expect(onPrivacyModeChange).not.toHaveBeenCalled();
  });

  it('marks recovery and review chrome while leaving prompt content explicitly preserved', () => {
    expect(recoverySource).toContain('data-sakura-surface="prompt-forge-recovery"');
    expect(reviewSource).toContain('data-sakura-surface="prompt-forge-review"');
    expect(reviewSource).toContain('data-sakura-surface="prompt-forge-review-header"');
    expect(reviewSource).toContain('data-sakura-surface="prompt-forge-review-tabs"');
    expect(reviewSource).toContain('data-sakura-content="prompt-forge-review-content"');
    expect(reviewSource).toContain('data-sakura-surface="prompt-forge-review-footer"');
  });

  it('matches the ink-panel contract without remote assets or content selectors', () => {
    expect(controlSource).toContain("import './sakura-prompt-forge.css'");
    expect(css).toContain("html[data-theme='sakura'] [data-sakura-surface='prompt-forge']");
    expect(css).toContain('var(--sakura-panel-strong-fallback)');
    expect(css).toContain('var(--sakura-pink-hsl)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).not.toMatch(/url\(|!important|\btextarea\b|data-sakura-content/i);
    expect(css).not.toContain("html[data-theme='monochrome']");
  });
});
