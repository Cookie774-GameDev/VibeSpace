import * as React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/ui';
import { PageRouter } from './PageRouter';

vi.mock('@/features/model-foundry', () => ({
  BuildYourOwnAIPage: () => (
    <main data-testid="model-foundry-page">Build Your Own AI local studio</main>
  ),
}));

describe('PageRouter Build Your Own AI route', () => {
  afterEach(() => {
    act(() => useUIStore.getState().resetUI());
  });

  it('renders the dedicated local studio as a first-class route', async () => {
    act(() => {
      useUIStore.getState().setRoute('model-foundry' as never);
    });

    render(<PageRouter />);

    expect(await screen.findByTestId('model-foundry-page')).toBeTruthy();
    expect(screen.getByRole('main').textContent).toContain('Build Your Own AI');
  });
});
