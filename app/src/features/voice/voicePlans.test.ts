import { describe, expect, it } from 'vitest';
import {
  COST_PER_SECOND_USD,
  VOICE_PLANS,
  VOICE_PRESETS,
  VOICE_PROVIDERS,
  usageCopy,
} from './voicePlans';

describe('VOICE_PLANS cost model', () => {
  it('derives seconds from budget at the shared cost-per-second', () => {
    expect(COST_PER_SECOND_USD).toBe(0.00025);
    expect(VOICE_PLANS.free.cloudSeconds).toBe(0);
    expect(VOICE_PLANS.starter.cloudSeconds).toBe(8000); // $2 / 0.00025
    expect(VOICE_PLANS.pro.cloudSeconds).toBe(40000); // $10
    expect(VOICE_PLANS.ultra.cloudSeconds).toBe(80000); // $20
  });

  it('has the correct sticker prices', () => {
    expect(VOICE_PLANS.free.priceUsd).toBe(0);
    expect(VOICE_PLANS.starter.priceUsd).toBe(10);
    expect(VOICE_PLANS.pro.priceUsd).toBe(50);
    expect(VOICE_PLANS.ultra.priceUsd).toBe(100);
  });
});

describe('VOICE_PRESETS', () => {
  it('maps Jarvis to bm_daniel and Friday to bf_emma', () => {
    expect(VOICE_PRESETS.jarvis.kokoroVoice).toBe('bm_daniel');
    expect(VOICE_PRESETS.friday.kokoroVoice).toBe('bf_emma');
  });

  it('keeps speeds in the plan-specified ranges', () => {
    expect(VOICE_PRESETS.jarvis.speed).toBeGreaterThanOrEqual(0.92);
    expect(VOICE_PRESETS.jarvis.speed).toBeLessThanOrEqual(0.96);
    expect(VOICE_PRESETS.friday.speed).toBeGreaterThanOrEqual(1.02);
    expect(VOICE_PRESETS.friday.speed).toBeLessThanOrEqual(1.08);
  });
});

describe('VOICE_PROVIDERS', () => {
  it('flags only the three cloud providers as cloud', () => {
    expect(VOICE_PROVIDERS.kokoro_local.cloud).toBe(false);
    expect(VOICE_PROVIDERS.system_tts_fallback.cloud).toBe(false);
    expect(VOICE_PROVIDERS.openai_tts.cloud).toBe(true);
    expect(VOICE_PROVIDERS.deepgram_tts.cloud).toBe(true);
    expect(VOICE_PROVIDERS.elevenlabs_tts.cloud).toBe(true);
  });
});

describe('usageCopy', () => {
  it('free plan says cloud not included', () => {
    expect(usageCopy('free', 0, 0)).toContain('not included');
  });
  it('starter shows minutes', () => {
    expect(usageCopy('starter', 600, 8000)).toContain('min');
    expect(usageCopy('starter', 600, 8000)).toContain('unlimited');
  });
  it('pro/ultra show hours', () => {
    expect(usageCopy('pro', 3600, 40000)).toContain('hr');
    expect(usageCopy('ultra', 3600, 80000)).toContain('hr');
  });
});
