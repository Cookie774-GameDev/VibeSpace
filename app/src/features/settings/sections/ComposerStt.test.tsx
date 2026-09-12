import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { ComposerStt } from './ComposerStt';

vi.mock('@/features/composer-stt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/composer-stt')>();
  return {
    ...actual,
    isSystemSttAvailable: () => true,
    FasterWhisperManager: {
      checkInstalled: vi.fn(async () => false),
      downloadModel: vi.fn(async () => true),
      removeModel: vi.fn(async () => true),
    },
  };
});

vi.mock('@/lib/deepgram', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/deepgram')>();
  return {
    ...actual,
    loadDeepgramCredential: vi.fn(async () => ({ configured: false, health: 'missing' })),
    getDeepgramApiKey: vi.fn(async () => undefined),
  };
});

describe('ComposerStt settings', () => {
  beforeEach(() => {
    useAuthStore.setState({
      composerSttProvider: 'system',
      fasterWhisperModel: 'whisper-small-en-q8',
    });
  });

  it('renders Free System, Local, and Deepgram choices', () => {
    render(<ComposerStt />);
    expect(screen.getByRole('radio', { name: /Free System/i })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /^Local/i })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Deepgram/i })).toBeTruthy();
  });

  it('lists every requested local catalog label with honest placement', () => {
    render(<ComposerStt />);
    fireEvent.click(screen.getByRole('radio', { name: /^Local/i }));

    expect(screen.getByText('Moonshine Medium Streaming')).toBeTruthy();
    expect(screen.getByText('Moonshine Medium Streaming Q4 — best one!')).toBeTruthy();
    expect(screen.getByText('Whisper small.en Q8')).toBeTruthy();
    expect(screen.getByText('Whisper base.en Q5')).toBeTruthy();
    expect(screen.getByText('Moonshine Tiny Streaming Q4')).toBeTruthy();
    expect(screen.getByText('Cohere Transcribe 03-2026')).toBeTruthy();

    expect(
      screen
        .getByTestId('stt-catalog-moonshine-medium-streaming-q4')
        .getAttribute('data-placement'),
    ).toBe('local-runtime-pending');
    expect(
      screen.getByTestId('stt-catalog-cohere-transcribe-03-2026').getAttribute('data-placement'),
    ).toBe('cloud-or-advanced');
    expect(
      screen.getByTestId('stt-catalog-whisper-small-en-q8').getAttribute('data-placement'),
    ).toBe('local-downloadable');
  });

  it('selects a downloadable Whisper pack as the active local model', async () => {
    render(<ComposerStt />);
    fireEvent.click(screen.getByRole('radio', { name: /^Local/i }));
    fireEvent.click(screen.getByText('Whisper base.en Q5'));

    await waitFor(() => {
      expect(useAuthStore.getState().composerSttProvider).toBe('faster-whisper');
      expect(useAuthStore.getState().fasterWhisperModel).toBe('whisper-base-en-q5');
    });
  });

  it('exposes the shared Deepgram credential and five verified STT choices', async () => {
    render(<ComposerStt />);
    fireEvent.click(screen.getByRole('radio', { name: /Deepgram/i }));
    expect(useAuthStore.getState().composerSttProvider).toBe('deepgram');
    expect(await screen.findByLabelText('Deepgram API key')).toBeTruthy();
    expect(screen.getAllByText('Nova-3 Monolingual').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Nova-2 Compatibility').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Nova-3 Multilingual').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Flux English').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Flux Multilingual').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('deepgram-model-mark')).toHaveLength(5);
    expect(screen.getByRole('img', { name: 'Nova-3 Monolingual model' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Flux English model' })).toBeTruthy();
    expect(screen.getByText(/Prices verified 2026-08-02/i)).toBeTruthy();
  });

  it('calculates intended usage with literal model pricing and unit conversion', async () => {
    render(<ComposerStt />);
    fireEvent.click(screen.getByRole('radio', { name: /Deepgram/i }));

    fireEvent.change(await screen.findByLabelText('Calculator model'), {
      target: { value: 'flux-multi' },
    });
    fireEvent.change(screen.getByLabelText('Intended usage hours'), {
      target: { value: '2' },
    });

    expect(screen.getByText('$0.9360 estimated')).toBeTruthy();
  });
});
