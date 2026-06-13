import { describe, expect, it } from 'vitest';
import {
  deepgramPromoLabel,
  FOUNDER_WELCOME_VOICE_USD,
  LAUNCH_FOUNDER_SLOTS,
  LAUNCH_SPARK_PROMO_SLOTS,
  SPARK_PROMO_VOICE_USD,
} from './callVoiceMarketing';

describe('callVoiceMarketing', () => {
  it('only first 200 get $5 in phase 1', () => {
    expect(LAUNCH_FOUNDER_SLOTS).toBe(200);
    expect(FOUNDER_WELCOME_VOICE_USD).toBe(5);
    expect(deepgramPromoLabel('free', 'launch_1k')).toBeNull();
  });

  it('phase 2 spark promo is $2 for 1000 users only', () => {
    expect(LAUNCH_SPARK_PROMO_SLOTS).toBe(1000);
    expect(SPARK_PROMO_VOICE_USD).toBe(2);
    expect(deepgramPromoLabel('free', 'scale_5k')).toContain('$2');
  });

  it('boosts paid subscriptions at 5k phase', () => {
    expect(deepgramPromoLabel('ultra', 'scale_5k')).toContain('15 hr');
  });
});
