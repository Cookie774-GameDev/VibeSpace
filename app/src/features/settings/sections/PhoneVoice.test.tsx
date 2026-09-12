import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PHONE_SETTINGS_DRAFT_KEY,
  PhoneVoice,
  mergePhoneSettingsForDisplay,
  separateLegacyPhoneDeepgramCredential,
} from './PhoneVoice';
import { useAuthStore } from '@/stores/auth';

const mocks = vi.hoisted(() => ({
  supabaseClient: null as unknown,
  migrateDeepgram: vi.fn(),
  secureSetApiKey: vi.fn(),
  readiness: {
    state: 'missing',
    message: 'This build does not include a phone backend URL.',
  } as const,
}));

vi.mock('@/lib/security/secureApiKeys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/secureApiKeys')>();
  return { ...actual, secureSetApiKey: mocks.secureSetApiKey };
});

vi.mock('@/lib/supabase/client', () => ({
  getSupabaseClient: () => mocks.supabaseClient,
}));

vi.mock('@/lib/deepgram', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/deepgram')>();
  return {
    ...actual,
    migrateDeepgramPlaintextCredential: mocks.migrateDeepgram,
    loadDeepgramCredential: vi.fn(async () => ({ configured: false, health: 'missing' })),
  };
});

vi.mock('@/lib/bridge', () => ({
  getBridgeClient: () => ({ getStatus: () => 'disabled' }),
}));

vi.mock('@/features/call/config', () => ({
  callCloudUrl: () => '',
  checkCallCloudReadiness: vi.fn(async () => mocks.readiness),
}));

describe('PhoneVoice autosave', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.supabaseClient = null;
    mocks.migrateDeepgram.mockReset();
    mocks.secureSetApiKey.mockReset();
    mocks.secureSetApiKey.mockResolvedValue(undefined);
    useAuthStore.setState({ apiKeys: {} });
  });

  it('keeps local drafts ahead of stale remote phone settings', () => {
    window.localStorage.setItem(
      PHONE_SETTINGS_DRAFT_KEY,
      JSON.stringify({
        user_phone_number: '+15557654321',
        unlock_phrase: 'open sesame',
        byok_provider_keys: { groq: 'gsk_local_secret' },
      }),
    );

    const merged = mergePhoneSettingsForDisplay({
      user_phone_number: null,
      unlock_phrase: 'remote phrase',
      byok_provider_keys: { groq: 'remote-key' },
    });

    expect(merged.user_phone_number).toBe('+15557654321');
    expect(merged.unlock_phrase).toBe('open sesame');
    expect(merged.byok_provider_keys?.groq).toBe('remote-key');
  });

  it('extracts a legacy Deepgram key without retaining it in phone settings', () => {
    const separated = separateLegacyPhoneDeepgramCredential({
      byok_provider_keys: {
        groq: 'gsk-kept',
        deepgram: 'dg-migrate-once',
        cartesia: 'cartesia-kept',
      },
    });

    expect(separated.legacyKey).toBe('dg-migrate-once');
    expect(separated.settings?.byok_provider_keys).toEqual({ cartesia: 'cartesia-kept' });
    expect(separated.legacyApiKeys).toEqual({ groq: 'gsk-kept' });
    expect(JSON.stringify(separated.settings)).not.toContain('dg-migrate-once');
  });

  it('migrates and removes a legacy cloud Deepgram key during the real load flow', async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    mocks.migrateDeepgram.mockResolvedValue({
      configured: true,
      health: 'connected',
      source: 'saved',
    });
    mocks.supabaseClient = {
      auth: {
        getSession: vi.fn(async () => ({ data: { session: { user: { id: 'account-1' } } } })),
      },
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                byok_provider_keys: {
                  groq: 'gsk-kept',
                  deepgram: 'dg-migrate-once',
                },
              },
              error: null,
            }),
          }),
        }),
        upsert,
      })),
    };

    render(<PhoneVoice />);

    await vi.waitFor(() => expect(mocks.migrateDeepgram).toHaveBeenCalledWith('dg-migrate-once'));
    await vi.waitFor(() =>
      expect(upsert).toHaveBeenCalledWith(
        {
          user_id: 'account-1',
          byok_provider_keys: {},
        },
        { onConflict: 'user_id' },
      ),
    );
    expect(mocks.secureSetApiKey).toHaveBeenCalledWith('groq', 'gsk-kept');
  });

  it('autosaves the phone number draft before debounce or navigation', async () => {
    const rendered = render(<PhoneVoice />);
    const phone = await screen.findByLabelText('Your number');

    fireEvent.change(phone, { target: { value: '+15550001111' } });
    rendered.unmount();

    const saved = JSON.parse(window.localStorage.getItem(PHONE_SETTINGS_DRAFT_KEY) ?? '{}') as {
      user_phone_number?: string;
    };
    expect(saved.user_phone_number).toBe('+15550001111');
  });

  it('reuses app-wide secure provider credentials without rendering duplicate key fields', async () => {
    useAuthStore.setState({
      apiKeys: { groq: 'gsk-secure', anthropic: 'sk-ant-secure' },
    });
    render(<PhoneVoice />);

    expect(await screen.findByText('Groq connected')).not.toBeNull();
    expect(screen.getByText('Anthropic connected')).not.toBeNull();
    expect(screen.queryByPlaceholderText('gsk_…')).toBeNull();
    expect(screen.queryByPlaceholderText('sk-ant-…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Manage provider keys' })).not.toBeNull();
  });

  it('shows a truthful missing-backend recovery state rather than a fake URL', async () => {
    render(<PhoneVoice />);

    expect(
      await screen.findByRole('heading', { name: 'Phone backend needs configuration' }),
    ).not.toBeNull();
    expect(screen.getByText(/does not include a phone backend URL/i)).not.toBeNull();
    expect(screen.queryByText(/localhost/i)).toBeNull();
  });

  it('presents the six owner-approved phone setup areas in a clear order', async () => {
    render(<PhoneVoice />);

    const headings = await screen.findAllByRole('heading');
    const labels = headings.map((heading) => heading.textContent);
    const required = [
      'My number',
      'Contacts',
      'Calling provider',
      'Voice provider',
      'Test call',
      'Call history & diagnostics',
    ];

    expect(required.every((label) => labels.includes(label))).toBe(true);
    const positions = required.map((label) => labels.indexOf(label));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('autosaves the unlock phrase draft before debounce or navigation', async () => {
    const rendered = render(<PhoneVoice />);
    const phrase = await screen.findByPlaceholderText('unlock shell');

    fireEvent.change(phrase, { target: { value: 'voice unlock only' } });
    rendered.unmount();

    const saved = JSON.parse(window.localStorage.getItem(PHONE_SETTINGS_DRAFT_KEY) ?? '{}') as {
      unlock_phrase?: string;
    };
    expect(saved.unlock_phrase).toBe('voice unlock only');
  });
});
