import { describe, expect, it } from 'vitest';
import { createResourcePressureController } from './resourcePressure';

describe('resource pressure controller', () => {
  it('triggers safe cleanup only above the heap threshold and respects cooldown', () => {
    const controller = createResourcePressureController({
      threshold: 0.8,
      cooldownMs: 30_000,
    });

    expect(controller.evaluate({ usedBytes: 70, limitBytes: 100 }, 1_000)).toBe(false);
    expect(controller.evaluate({ usedBytes: 81, limitBytes: 100 }, 2_000)).toBe(true);
    expect(controller.evaluate({ usedBytes: 90, limitBytes: 100 }, 20_000)).toBe(false);
    expect(controller.evaluate({ usedBytes: 90, limitBytes: 100 }, 32_000)).toBe(true);
  });

  it('fails open when Chromium heap information is unavailable or invalid', () => {
    const controller = createResourcePressureController();

    expect(controller.evaluate(null, 1_000)).toBe(false);
    expect(controller.evaluate({ usedBytes: 10, limitBytes: 0 }, 2_000)).toBe(false);
  });
});
