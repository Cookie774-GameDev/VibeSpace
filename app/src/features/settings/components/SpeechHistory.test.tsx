import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpeechHistory } from './SpeechHistory';
import { createSpeechHistorySession } from '@/features/composer-stt/speechHistory';

describe('Speech history settings', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });
  it('updates live, copies exact recovered text, and deletes it', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<SpeechHistory />);
    expect(screen.getByText('Your dictated text will appear here.')).toBeTruthy();
    act(() => {
      const talk = createSpeechHistorySession('system');
      talk.partial('café 🎤\nsecond line');
      talk.finish('interrupted');
    });
    expect(screen.getByText('1 / 50')).toBeTruthy();
    expect(screen.getByText(/Interrupted · text saved/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy transcript' })));
    expect(writeText).toHaveBeenCalledWith('café 🎤\nsecond line');
    expect(screen.getByRole('status').textContent).toBe('Transcript copied');
    fireEvent.click(screen.getByRole('button', { name: 'Delete transcript' }));
    expect(screen.getByText('0 / 50')).toBeTruthy();
  });
  it('refreshes changes from another native WebView and keeps text selectable when copying fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw Error('denied');
        }),
      },
    });
    render(<SpeechHistory />);
    act(() => {
      localStorage.setItem(
        'vibespace:speech-history:v1:other',
        JSON.stringify({
          id: 'other',
          startedAt: 1000,
          provider: 'system',
          status: 'saved',
          text: 'recovered elsewhere',
        }),
      );
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'vibespace:speech-history:v1:other' }),
      );
    });
    expect(screen.getByText('recovered elsewhere').className).toContain('select-text');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy transcript' })));
    expect(screen.getByRole('alert').textContent).toContain('copy it manually');
  });
});
