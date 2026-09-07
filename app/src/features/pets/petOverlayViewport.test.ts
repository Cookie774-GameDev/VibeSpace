import { describe, expect, it } from 'vitest';
import { resolvePetOverlayViewport } from './petOverlayViewport';

describe('resolvePetOverlayViewport', () => {
  it('fits the Pet inside a 125%-scaled 116px detached WebView', () => {
    expect(resolvePetOverlayViewport(116, 116)).toEqual({ shellSize: 116, displaySize: 100 });
  });

  it('keeps the intended 128px Pet when the WebView has the full 144px logical viewport', () => {
    expect(resolvePetOverlayViewport(144, 144)).toEqual({ shellSize: 144, displaySize: 128 });
  });

  it('uses a larger pet while preserving clear padding in the enlarged native window', () => {
    expect(resolvePetOverlayViewport(192, 192)).toEqual({ shellSize: 192, displaySize: 176 });
    expect(resolvePetOverlayViewport(154, 154)).toEqual({ shellSize: 154, displaySize: 138 });
  });

  it('never overflows very small detached viewports', () => {
    const resolved = resolvePetOverlayViewport(80, 72);
    expect(resolved.shellSize).toBe(72);
    expect(resolved.displaySize).toBeLessThanOrEqual(resolved.shellSize);
    expect(resolved.displaySize).toBe(56);
  });
});
