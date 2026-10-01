import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { JarvisVoiceHeader } from './JarvisVoiceHeader';

vi.mock('./Orb', () => ({
  Orb: () => <span data-testid="voice-orb" />,
}));

vi.mock('./VoiceActivityWaveform', () => ({
  VoiceActivityWaveform: () => <canvas data-testid="voice-waveform" aria-hidden="true" />,
}));

describe('JarvisVoiceHeader accessibility', () => {
  it('announces the textual voice state through one restrained atomic status', () => {
    render(
      <JarvisVoiceHeader
        state="listening"
        personaName="Jarvis"
        listeningHint='Listening - say "send it" to send'
        voiceAutoListenOnOpen
        voiceCommitPhrase="send it"
        levelRef={{ current: 0.4 }}
        onClose={vi.fn()}
        onToggleListening={vi.fn()}
        onPointerDown={vi.fn()}
        onPointerMove={vi.fn()}
        onPointerUp={vi.fn()}
        onPointerCancel={vi.fn()}
      />,
    );

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-atomic')).toBe('true');
    expect(status.textContent).toContain('Listening');
    expect(status.getAttribute('title')).toContain('Listening - say "send it" to send');
    expect(status.classList.contains('jarvis-voice-status')).toBe(true);
    expect(screen.getByText('Jarvis').classList.contains('jarvis-voice-title')).toBe(true);
    expect(screen.getByTestId('voice-waveform').getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps error copy contrast-safe while retaining a redundant destructive status cue', () => {
    const view = render(
      <JarvisVoiceHeader
        state="error"
        personaName="Jarvis"
        listeningHint="Voice error"
        errorMessage="Microphone permission was denied."
        voiceAutoListenOnOpen
        voiceCommitPhrase="send it"
        levelRef={{ current: 0 }}
        onClose={vi.fn()}
        onToggleListening={vi.fn()}
        onPointerDown={vi.fn()}
        onPointerMove={vi.fn()}
        onPointerUp={vi.fn()}
        onPointerCancel={vi.fn()}
      />,
    );

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Microphone permission was denied.');
    expect(status.classList.contains('text-foreground')).toBe(true);
    expect(status.classList.contains('text-destructive')).toBe(false);
    expect(view.container.querySelector('.bg-destructive')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });
});
