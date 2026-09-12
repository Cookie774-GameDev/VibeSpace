import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { telemetryConsentStore } from '@/features/telemetry/telemetryConsent';
import { Telemetry } from './Telemetry';

describe('Telemetry settings', () => {
  beforeEach(() => telemetryConsentStore.resetForTests());

  it('explains collection boundaries and keeps every optional class off initially', async () => {
    render(<Telemetry />);
    await screen.findByText(/Sign in to a configured VibeSpace account/i);
    expect(screen.getByRole('heading', { name: 'Anonymous telemetry' })).toBeTruthy();
    expect(screen.getByText(/Essential crash and security logging/i)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Local AI diagnostics' })).toBeTruthy();
    expect(screen.getByText(/stay in process memory/i)).toBeTruthy();
    expect(screen.getByText('External telemetry exporter').nextElementSibling?.textContent).toBe(
      'Off',
    );
    expect(
      screen.getByText(/Prompts, message contents, generated text, source code/i),
    ).toBeTruthy();
    expect(
      screen.getByRole('switch', { name: 'Share product usage' }).getAttribute('data-state'),
    ).toBe('unchecked');
    expect(
      screen.getByRole('switch', { name: 'Share diagnostics' }).getAttribute('data-state'),
    ).toBe('unchecked');
    expect(
      screen.getByRole('switch', { name: 'Share tool outcomes' }).getAttribute('data-state'),
    ).toBe('unchecked');
  });

  it('records consent and lets the user revoke it without a dark pattern', async () => {
    render(<Telemetry />);
    await screen.findByText(/Sign in to a configured VibeSpace account/i);
    fireEvent.click(screen.getByRole('switch', { name: 'Share product usage' }));
    expect(
      screen.getByRole('switch', { name: 'Share product usage' }).getAttribute('data-state'),
    ).toBe('checked');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke optional telemetry' }));
    expect(
      screen.getByRole('switch', { name: 'Share product usage' }).getAttribute('data-state'),
    ).toBe('unchecked');
  });
});
