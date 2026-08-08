import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { PLAN_ORDER, PLANS, type PlanId } from '@/lib/entitlements';
import { Plans } from './Plans';

const billingConfiguredMock = vi.hoisted(() => vi.fn(() => true));
const checkoutMock = vi.fn();
const portalMock = vi.fn();
const openExternalMock = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();

vi.mock('@/lib/billing/checkout', () => ({
  callCheckoutSession: (...args: unknown[]) => checkoutMock(...args),
  callCustomerPortal: (...args: unknown[]) => portalMock(...args),
  isBackendBillingConfigured: () => billingConfiguredMock(),
}));

vi.mock('@/lib/tauri', () => ({
  openExternal: (...args: unknown[]) => openExternalMock(...args),
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    info: (...args: unknown[]) => toastInfo(...args),
    success: vi.fn(),
  },
}));

vi.mock('@/lib/admin', () => ({
  useAppAdmin: () => false,
}));

describe('Plans website-parity billing UI', () => {
  beforeEach(() => {
    checkoutMock.mockReset();
    portalMock.mockReset();
    openExternalMock.mockReset();
    toastError.mockReset();
    toastInfo.mockReset();
    billingConfiguredMock.mockReset();
    billingConfiguredMock.mockReturnValue(true);
    openExternalMock.mockResolvedValue(undefined);
    useAuthStore.setState({
      plan: 'free',
      cloudSession: { user_id: 'user-1', email: 'u@example.com' } as never,
    });
  });

  afterEach(cleanup);

  it('renders Access ledger + every authoritative feature plan card', async () => {
    render(<Plans />);

    expect(screen.getByRole('heading', { name: 'VibeSpace Access' })).toBeTruthy();
    expect(screen.getByText('$20')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Review Access terms/i })).toBeTruthy();

    await waitFor(() => {
      expect(document.querySelector('[data-plans-ready="true"]')).not.toBeNull();
    });

    for (const id of PLAN_ORDER) {
      const plan = PLANS[id];
      const article = document.querySelector(`[data-plan-id="${id}"]`);
      expect(article).not.toBeNull();
      expect(article?.textContent).toContain(plan.label);
      if (plan.priceUsd === 0) {
        expect(article?.getAttribute('aria-label')).toBe(`${plan.label} plan, free`);
      } else {
        expect(article?.getAttribute('aria-label')).toBe(
          `${plan.label} plan, $${plan.priceUsd} per month`,
        );
      }
    }

    const recommended = document.querySelector('[data-plan-id="pro"]');
    expect(recommended?.className).toContain('vs-plan-card--featured');
    expect(recommended?.getAttribute('data-plan-recommended')).toBe('true');
  });

  it('keeps website-like card proportions while preserving every entitlement', async () => {
    render(<Plans />);

    await waitFor(() => {
      expect(document.querySelector('[data-plans-ready="true"]')).not.toBeNull();
    });

    for (const id of PLAN_ORDER) {
      const plan = PLANS[id];
      const article = document.querySelector(`[data-plan-id="${id}"]`);
      const visibleBenefits = article?.querySelectorAll(':scope > .vs-plan-card__features > li');
      expect(visibleBenefits?.length).toBe(Math.min(4, plan.features.length));

      for (const benefit of plan.features) {
        expect(article?.textContent).toContain(benefit);
      }

      if (plan.features.length > 4) {
        const disclosure = article?.querySelector('details');
        expect(disclosure?.textContent).toContain(`Show ${plan.features.length - 4} more benefits`);
      }
    }
  });

  it('marks the active plan and uses portal for current/downgrade actions', async () => {
    useAuthStore.setState({
      plan: 'pro',
      cloudSession: { user_id: 'user-1', email: 'u@example.com' } as never,
    });
    portalMock.mockResolvedValue({ ok: true, url: 'https://billing.example/portal' });

    render(<Plans />);
    await waitFor(() => {
      expect(document.querySelector('[data-plans-ready="true"]')).not.toBeNull();
    });

    const nova = document.querySelector('[data-plan-id="pro"]');
    expect(nova?.getAttribute('data-plan-current')).toBe('true');
    expect(screen.getAllByText('Current plan').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /Manage subscription/i }));
    await waitFor(() => {
      expect(portalMock).toHaveBeenCalledTimes(1);
      expect(openExternalMock).toHaveBeenCalledWith('https://billing.example/portal');
    });
  });

  it('starts real Stripe checkout for an upgrade CTA', async () => {
    checkoutMock.mockResolvedValue({ ok: true, url: 'https://checkout.stripe.test/session' });

    render(<Plans />);
    await waitFor(() => {
      expect(document.querySelector('[data-plans-ready="true"]')).not.toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /Upgrade — \$50\/mo/i }));
    await waitFor(() => {
      expect(checkoutMock).toHaveBeenCalledWith('pro');
      expect(openExternalMock).toHaveBeenCalledWith('https://checkout.stripe.test/session');
    });
  });

  it('surfaces billing errors without turning CTAs into mocks', async () => {
    checkoutMock.mockResolvedValue({ ok: false, error: 'stripe_unavailable' });

    render(<Plans />);
    await waitFor(() => {
      expect(document.querySelector('[data-plans-ready="true"]')).not.toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /Upgrade — \$10\/mo/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/stripe_unavailable/i);
      expect(toastError).toHaveBeenCalled();
      expect(openExternalMock).not.toHaveBeenCalled();
    });
  });

  it('exposes a truthful unavailable state without replacing the real checkout path', async () => {
    billingConfiguredMock.mockReturnValue(false);

    render(<Plans />);
    await waitFor(() => {
      expect(document.querySelector('[data-plans-ready="true"]')).not.toBeNull();
    });

    expect(screen.getByText(/Billing not configured/i)).toBeTruthy();
    const upgrade = screen.getByRole('button', { name: /Upgrade — \$10\/mo/i });
    expect(upgrade.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(upgrade);
    expect(checkoutMock).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith(
      'Checkout unavailable',
      expect.stringMatching(/Billing is not configured/i),
    );
  });

  it('announces the real checkout loading state', async () => {
    let completeCheckout!: (value: { ok: true; url: string }) => void;
    checkoutMock.mockReturnValue(
      new Promise((resolve) => {
        completeCheckout = resolve;
      }),
    );

    render(<Plans />);
    await waitFor(() => {
      expect(document.querySelector('[data-plans-ready="true"]')).not.toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /Upgrade — \$50\/mo/i }));
    expect(await screen.findByRole('button', { name: /Starting checkout/i })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Feature plans' }).getAttribute('aria-busy')).toBe(
      'true',
    );

    completeCheckout({ ok: true, url: 'https://checkout.stripe.test/loading-state' });
    await waitFor(() => {
      expect(openExternalMock).toHaveBeenCalledWith('https://checkout.stripe.test/loading-state');
    });
  });

  it('renders an explicit empty-catalog state', () => {
    const mutablePlanOrder = PLAN_ORDER as unknown as PlanId[];
    const originalOrder = [...mutablePlanOrder];
    mutablePlanOrder.splice(0, mutablePlanOrder.length);

    try {
      render(<Plans />);
      expect(screen.getByText('No plan catalog is available in this build.')).toBeTruthy();
      expect(screen.queryByRole('list', { name: 'Feature plans' })).toBeNull();
    } finally {
      mutablePlanOrder.push(...originalOrder);
    }
  });

  it('routes free-tier key CTA to providers settings', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<Plans />);
    await waitFor(() => {
      expect(document.querySelector('[data-plans-ready="true"]')).not.toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /Add a key/i }));
    expect(dispatchSpy).toHaveBeenCalled();
    const evt = dispatchSpy.mock.calls.map((c) => c[0]).find((e) => e instanceof CustomEvent) as
      | CustomEvent
      | undefined;
    expect(evt?.type).toBe('jarvis:settings:tab');
    expect((evt as CustomEvent).detail).toEqual({ tab: 'providers' });
    dispatchSpy.mockRestore();
  });
});
