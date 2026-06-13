import { describe, expect, it } from 'vitest';
import {
  CALL_VOICE_BUDGET_USD,
  callVoiceBucketLine,
  formatCloudVoiceMaxLabel,
  maxCloudVoiceMinutes,
  PHONE_MINUTES_BY_PLAN,
} from './callVoiceMarketing';

describe('callVoiceMarketing', () => {
  it('matches server phone-minute headlines', () => {
    expect(PHONE_MINUTES_BY_PLAN.starter).toBe(22);
    expect(PHONE_MINUTES_BY_PLAN.pro).toBe(109);
    expect(PHONE_MINUTES_BY_PLAN.ultra).toBe(217);
  });

  it('computes cloud voice max from budget / 0.015', () => {
    expect(maxCloudVoiceMinutes(CALL_VOICE_BUDGET_USD.starter)).toBe(144);
    expect(maxCloudVoiceMinutes(CALL_VOICE_BUDGET_USD.pro)).toBe(723);
    expect(maxCloudVoiceMinutes(CALL_VOICE_BUDGET_USD.ultra)).toBe(1446);
  });

  it('formats marketing labels conservatively', () => {
    expect(formatCloudVoiceMaxLabel(2.17)).toBe('~140+');
    expect(formatCloudVoiceMaxLabel(10.85)).toBe('~720+');
    expect(formatCloudVoiceMaxLabel(21.7)).toBe('~1,400+');
  });

  it('builds combined bucket lines', () => {
    expect(callVoiceBucketLine('ultra')).toBe(
      '217 AI phone min/mo · up to ~1,400+ min in-app cloud voice',
    );
  });
});
