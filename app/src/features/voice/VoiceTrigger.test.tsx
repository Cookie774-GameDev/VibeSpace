import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { VoiceTrigger } from './VoiceTrigger';

function ControlledVoiceTrigger() {
  const [active, setActive] = React.useState(false);
  return (
    <TooltipProvider>
      <VoiceTrigger active={active} onActiveChange={setActive} />
    </TooltipProvider>
  );
}

describe('VoiceTrigger', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps voice open after a held summon is released', () => {
    vi.useFakeTimers();
    render(<ControlledVoiceTrigger />);
    const button = screen.getByRole('button', { name: /start voice session/i });

    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(560);
    });
    expect(button.getAttribute('aria-pressed')).toBe('true');

    fireEvent.pointerUp(button, { button: 0, pointerId: 1 });

    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('still toggles voice on quick taps', () => {
    vi.useFakeTimers();
    render(<ControlledVoiceTrigger />);
    const button = screen.getByRole('button', { name: /start voice session/i });

    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(button, { button: 0, pointerId: 1 });
    expect(button.getAttribute('aria-pressed')).toBe('true');

    fireEvent.pointerDown(button, { button: 0, pointerId: 2 });
    fireEvent.pointerUp(button, { button: 0, pointerId: 2 });
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('uses the symbiote glow treatment while idle', () => {
    render(<ControlledVoiceTrigger />);

    expect(screen.getByRole('button', { name: /start voice session/i }).className).toContain(
      'jarvis-symbiote-trigger',
    );
  });
});
