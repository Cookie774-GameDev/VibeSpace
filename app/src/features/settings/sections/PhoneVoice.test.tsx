import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PHONE_SETTINGS_DRAFT_KEY,
  PhoneVoice,
  mergePhoneSettingsForDisplay,
} from './PhoneVoice';

vi.mock('@/lib/supabase/client', () => ({
  getSupabaseClient: () => null,
}));

vi.mock('@/lib/bridge', () => ({
  getBridgeClient: () => ({ getStatus: () => 'disabled' }),
}));

vi.mock('@/features/call/CallService', () => ({
  getCallService: () => ({ getCloudUrl: () => '' }),
}));

describe('PhoneVoice autosave', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('keeps local drafts ahead of stale remote phone settings', () => {
    window.localStorage.setItem(PHONE_SETTINGS_DRAFT_KEY, JSON.stringify({
      user_phone_number: '+15557654321',
      unlock_phrase: 'open sesame',
      byok_provider_keys: { groq: 'gsk_local_secret' },
    }));

    const merged = mergePhoneSettingsForDisplay({
      user_phone_number: null,
      unlock_phrase: 'remote phrase',
      byok_provider_keys: { groq: 'remote-key' },
    });

    expect(merged.user_phone_number).toBe('+15557654321');
    expect(merged.unlock_phrase).toBe('open sesame');
    expect(merged.byok_provider_keys?.groq).toBe('remote-key');
  });

  it('autosaves the phone number draft before debounce or navigation', async () => {
    const rendered = render(<PhoneVoice />);
    const phoneInputs = await screen.findAllByPlaceholderText('+15551234567');
    const phone = phoneInputs.at(-1);
    expect(phone).toBeTruthy();

    fireEvent.change(phone!, { target: { value: '+15550001111' } });
    rendered.unmount();

    const saved = JSON.parse(window.localStorage.getItem(PHONE_SETTINGS_DRAFT_KEY) ?? '{}') as {
      user_phone_number?: string;
    };
    expect(saved.user_phone_number).toBe('+15550001111');
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
