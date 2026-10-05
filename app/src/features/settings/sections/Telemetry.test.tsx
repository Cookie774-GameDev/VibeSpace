import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { telemetryConsentStore } from '@/features/telemetry/telemetryConsent';
import { Telemetry } from './Telemetry';
import {
  getAccountTelemetryConsent,
  updateAccountTelemetryConsent,
} from '@/features/telemetry/accountTelemetryConsent';

const account = vi.hoisted(() => ({ cloudSession: null as null | { user_id: string } }));
vi.mock('@/stores/auth', () => ({
  useAuthStore: Object.assign((selector: (state: typeof account) => unknown) => selector(account), {
    getState: () => account,
  }),
}));

vi.mock('@/features/telemetry/accountTelemetryConsent', () => ({
  getAccountTelemetryConsent: vi.fn(async () => ({ ok: false, error: 'cloud_not_configured' })),
  updateAccountTelemetryConsent: vi.fn(),
}));

describe('Telemetry settings', () => {
  beforeEach(() => {
    account.cloudSession = null;
    telemetryConsentStore.resetForTests();
    vi.mocked(getAccountTelemetryConsent).mockResolvedValue({
      ok: false,
      error: 'cloud_not_configured',
    });
    vi.mocked(updateAccountTelemetryConsent).mockReset();
  });

  it('explains collection boundaries and keeps every optional class off initially', async () => {
    render(<Telemetry />);
    await screen.findByText(/Sign in to a configured VibeSpace account/i);
    expect(screen.getByRole('heading', { name: 'Optional telemetry' })).toBeTruthy();
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

  it('explains a server configuration failure for a signed-in account and keeps enrollment off', async () => {
    account.cloudSession = { user_id: 'telemetry-ui-test' };
    vi.mocked(getAccountTelemetryConsent).mockResolvedValue({
      ok: false,
      error: 'telemetry_reward_unconfigured',
    });
    render(<Telemetry />);
    await screen.findByText(
      /Telemetry rewards are unavailable because the service is not configured/i,
    );
    expect(screen.queryByText(/Sign in to a configured VibeSpace account/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enable 10% reward' })).toBeNull();
    expect(telemetryConsentStore.getSnapshot().consent).toEqual({
      productUsage: false,
      diagnostics: false,
      toolOutcomes: false,
    });
  });

  it('does not ask a signed-in account to sign in again after a request failure', async () => {
    account.cloudSession = { user_id: 'telemetry-ui-test' };
    vi.mocked(getAccountTelemetryConsent).mockResolvedValue({ ok: false, error: 'request_failed' });
    render(<Telemetry />);
    await screen.findByText(/Unable to check account eligibility/i);
    expect(screen.queryByText(/Sign in to a configured VibeSpace account/i)).toBeNull();
  });

  it('stops sharing immediately and shows pending withdrawal when offline', async () => {
    account.cloudSession = { user_id: 'telemetry-ui-test' };
    const state = {
      enabled: true,
      eligible: true,
      policyVersion: 'v1',
      noticeUrl: 'https://example.test/notice',
      discountPercent: 10,
      requiredDataClasses: ['product_usage', 'diagnostics', 'tool_outcomes'],
    } as const;
    telemetryConsentStore.updateConsent({
      productUsage: true,
      diagnostics: true,
      toolOutcomes: true,
    });
    vi.mocked(getAccountTelemetryConsent).mockResolvedValue({ ok: true, state });
    vi.mocked(updateAccountTelemetryConsent).mockResolvedValue({ ok: false, error: 'offline' });
    render(<Telemetry />);
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw 10% reward consent' }));
    expect(telemetryConsentStore.getSnapshot().consent).toEqual({
      productUsage: false,
      diagnostics: false,
      toolOutcomes: false,
    });
    await screen.findByText(/withdrawal pending synchronization/i);
    expect(JSON.parse(localStorage.getItem('vibespace-telemetry-withdrawals-v1') ?? '[]')).toEqual([
      expect.objectContaining({ accountId: 'telemetry-ui-test' }),
    ]);
  });
});
