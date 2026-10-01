import { describe, expect, it } from 'vitest';
import {
  callCreditImpact,
  normalizeE164Phone,
  validateCallBrief,
  validateCallRecipient,
} from './callSetup';

describe('outbound call setup', () => {
  it('normalizes common formatting but requires an international E.164 number', () => {
    expect(normalizeE164Phone('+1 (312) 555-0192')).toBe('+13125550192');
    expect(normalizeE164Phone('312-555-0192')).toBeNull();
    expect(normalizeE164Phone('+0123')).toBeNull();
    expect(normalizeE164Phone('+1 911')).toBeNull();
  });

  it('returns specific recipient and brief validation messages', () => {
    expect(validateCallRecipient('', '')).toBe('Enter the recipient’s name.');
    expect(validateCallRecipient('Clinic', '3125550192')).toContain('country code');
    expect(validateCallRecipient('Clinic', '+13125550110')).toBeNull();
    expect(validateCallBrief('', 5)).toBe('Describe what this call should accomplish.');
    expect(validateCallBrief('Ask about office hours.', 0)).toContain('between 1 and 15');
    expect(validateCallBrief('Ask about office hours.', 5)).toBeNull();
  });

  it('explains the maximum reservation without presenting credits as a user charge', () => {
    expect(callCreditImpact(480)).toEqual({
      credits: 480,
      providerCostUsd: 0.48,
      copy: 'Up to 480 shared credits may be reserved (up to $0.48 of company-paid provider usage). Only actual usage is settled; unused credits return to your pool.',
    });
  });
});
