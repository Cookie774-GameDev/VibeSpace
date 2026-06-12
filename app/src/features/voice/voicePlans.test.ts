import { describe, expect, it } from 'vitest';
import {
  COST_PER_SECOND_USD,
  VOICE_PLANS,
  VOICE_PRESETS,
  VOICE_PROVIDERS,
  usageCopy,
  deepgramPromoCopy,
  DEEPGRAM_LAUNCH_PROMO,
} from './voicePlans';

describe('VOICE_PLANS cost model', () => {
  it('uses the shared call/voice budget (no separate voice-only budget)', () => {
    expect(COST_PER_SECOND_USD).toBe(0.00025);
    expect(VOICE_PLANS.free.callVoiceBudgetUsd).toBe(0);
    expect(VOICE_PLANS.starter.callVoiceBudgetUsd).toBe(2.5);
    expect(VOICE_PLANS.pro.callVoiceBudgetUsd).toBe(12.5);
    expect(VOICE_PLANS.ultra.callVoiceBudgetUsd).toBe(25);
  });

  it('derives max cloud seconds from the shared budget', () => {
    expect(VOICE_PLANS.free.cloudSecondsMax).toBe(0);
    expect(VOICE_PLANS.starter.cloudSecondsMax).toBe(10000); // $2.50 / 0.00025
    expect(VOICE_PLANS.pro.cloudSecondsMax).toBe(50000); // $12.50
    expect(VOICE_PLANS.ultra.cloudSecondsMax).toBe(100000); // $25
  });

  it('has the correct sticker prices', () => {
    expect(VOICE_PLANS.free.priceUsd).toBe(0);
    expect(VOICE_PLANS.starter.priceUsd).toBe(10);
    expect(VOICE_PLANS.pro.priceUsd).toBe(50);
    expect(VOICE_PLANS.ultra.priceUsd).toBe(100);
  });
});

describe('VOICE_PRESETS', () => {
  it('maps Jarvis to bm_george and Friday to bf_emma', () => {
    expect(VOICE_PRESETS.jarvis.kokoroVoice).toBe('bm_george');
    expect(VOICE_PRESETS.friday.kokoroVoice).toBe('bf_emma');
  });

  it('uses the configured Kokoro speeds', () => {
    expect(VOICE_PRESETS.jarvis.speed).toBeCloseTo(0.92, 2);
    expect(VOICE_PRESETS.friday.speed).toBeCloseTo(0.98, 2);
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

describe('DEEPGRAM_LAUNCH_PROMO', () => {
  it('allocates one-time seconds from the $6k pool by plan', () => {
    expect(DEEPGRAM_LAUNCH_PROMO.free.seconds).toBe(60);
    expect(DEEPGRAM_LAUNCH_PROMO.starter.seconds).toBe(1800);
    expect(DEEPGRAM_LAUNCH_PROMO.pro.seconds).toBe(5400);
    expect(DEEPGRAM_LAUNCH_PROMO.ultra.seconds).toBe(10800);
  });

  it('describes remaining launch Deepgram time', () => {
    expect(deepgramPromoCopy('free', 0, 60)).toContain('Launch Deepgram');
    expect(deepgramPromoCopy('free', 60, 60)).toContain('trial used');
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
