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
      screen.getAllByText(/Apply Ponytail guidance while preserving model and output behavior\./i),
    ).toHaveLength(2);
    expect(screen.queryByText(/Keep only high-value context/i)).toBeNull();
    expect(screen.queryByText(/Keep broader context/i)).toBeNull();
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

    const { rerender } = render(<TokenOptimizationReceiptView receipt={receipt} />);
    expect(screen.getByText('Why included')).toBeTruthy();
    expect(screen.getByText(/protected content/i)).toBeTruthy();
    expect(screen.getByText(/400 input tokens trimmed/i)).toBeTruthy();
    expect(screen.getByText('Unavailable for this turn')).toBeTruthy();
    expect(screen.getByText(/Ponytail Full guides this turn/)).toBeTruthy();
    expect(
      screen.getByText(/Zero means no input was removed, not that Ponytail was disabled/),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain('raw private text');

    rerender(
      <TokenOptimizationReceiptView
        receipt={{ ...receipt, fitsContext: false, overflowTokens: 12 }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'Estimated context exceeds this model by 12 tokens. Nothing was removed.',
    );
  });
});

it('shows conservative native validation pending without claiming a measured fit', () => {
  const receipt: TokenOptimizationReceipt = {
    mode: 'normal', providerId: 'foundry', modelId: 'artifact--job_public', modelChanged: false,
    tokenizerSource: 'conservative_estimate', outputTokenLimit: 320,
    estimatedInputTokensBefore: 10467, estimatedInputTokensAfter: 10467,
    estimatedTokensSaved: 0, selectedCount: 1, excludedCount: 0,
    fitsContext: false, overflowTokens: 2595, nativeValidationPending: true,
    inclusions: [{ segmentRef: 'segment-1', kind: 'system_instruction', tokens: 10467, reason: 'protected' }],
    exclusions: [],
  };
  render(<TokenOptimizationReceiptView receipt={receipt} />);
  expect(screen.getByRole('alert').textContent).toContain('Estimated context exceeds this model by 2,595 tokens.');
  expect(screen.getByRole('alert').textContent).toContain('The local model checks the complete input before generation.');
  expect(screen.getByRole('alert').textContent).toContain('Required content was preserved.');
  expect(screen.queryByText(/measured fit/i)).toBeNull();
});
