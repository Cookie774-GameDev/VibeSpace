import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  TokenOptimizationModeControl,
  TokenOptimizationReceiptView,
  type TokenOptimizationReceipt,
} from './index';

describe('Token Optimize standalone UI', () => {
  it('offers all four global modes and an inheritable per-chat override', () => {
    const onGlobalModeChange = vi.fn();
    const onChatOverrideChange = vi.fn();
    const { rerender } = render(
      <TokenOptimizationModeControl
        globalMode="normal"
        chatOverride={null}
        onGlobalModeChange={onGlobalModeChange}
        onChatOverrideChange={onChatOverrideChange}
      />,
    );

    expect(screen.getAllByRole('radio', { name: /^off/i })).toHaveLength(2);
    expect(screen.getAllByRole('radio', { name: /^saver/i })).toHaveLength(2);
    expect(screen.getAllByRole('radio', { name: /^normal/i })).toHaveLength(2);
    expect(screen.getAllByRole('radio', { name: /^final boss/i })).toHaveLength(2);
    expect(
      within(screen.getByRole('group', { name: 'This chat' }))
        .getAllByRole('radio')
        .filter((radio) => (radio as HTMLInputElement).checked),
    ).toHaveLength(1);
    fireEvent.click(screen.getAllByRole('radio', { name: /^saver/i })[0]!);
    expect(onGlobalModeChange).toHaveBeenCalledWith('saver');
    fireEvent.click(screen.getAllByRole('radio', { name: /^saver/i })[1]!);
    expect(onChatOverrideChange).toHaveBeenCalledWith('saver');
    rerender(
      <TokenOptimizationModeControl
        globalMode="normal"
        chatOverride="saver"
        onGlobalModeChange={onGlobalModeChange}
        onChatOverrideChange={onChatOverrideChange}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: /inherit global/i }));
    expect(onChatOverrideChange).toHaveBeenCalledWith(null);
  });

  it('renders a transparent safe-shaped receipt without raw segment text', () => {
    const receipt: TokenOptimizationReceipt = {
      mode: 'saver',
      providerId: 'openai',
      modelId: 'gpt-test',
      modelChanged: false,
      tokenizerSource: 'exact_local',
      outputTokenLimit: 512,
      estimatedInputTokensBefore: 1_000,
      estimatedInputTokensAfter: 600,
      estimatedTokensSaved: 400,
      selectedCount: 1,
      excludedCount: 1,
      fitsContext: true,
      overflowTokens: 0,
      inclusions: [
        {
          segmentRef: 'segment-1',
          kind: 'system_instruction',
          reason: 'protected',
          tokens: 200,
        },
      ],
      exclusions: [
        {
          segmentRef: 'segment-2',
          kind: 'documentation',
          reason: 'over_budget',
          tokens: 400,
        },
      ],
    };

    render(<TokenOptimizationReceiptView receipt={receipt} />);
    expect(screen.getByText('Why included')).toBeTruthy();
    expect(screen.getByText(/protected content/i)).toBeTruthy();
    expect(screen.getByText(/400 tokens saved/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain('raw private text');
  });
});
