import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  list: vi.fn(),
  permission: vi.fn(),
}));

vi.mock('@/features/voice/microphoneTest', () => ({
  captureMicrophoneSample: mocks.capture,
  listMicrophoneDevices: mocks.list,
  readMicrophonePermission: mocks.permission,
}));

import { MicrophoneTestPanel } from './MicrophoneTestPanel';

describe('MicrophoneTestPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    mocks.permission.mockResolvedValue('prompt');
    mocks.list.mockResolvedValue([
      { deviceId: 'mic-a', label: 'Studio microphone' },
      { deviceId: 'mic-b', label: 'Headset microphone' },
    ]);
    mocks.capture.mockImplementation(async ({ onLevel }: { onLevel: (level: number) => void }) => {
      onLevel(0.42);
      return {
        verdict: 'pass',
        passed: true,
        peakLevel: 0.42,
        averageLevel: 0.12,
        recording: new Blob(['voice'], { type: 'audio/webm' }),
      };
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:mic-test'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('shows permission and devices, captures the selected device, live level, playback, and pass', async () => {
    render(<MicrophoneTestPanel />);
    expect(await screen.findByText('Permission: Ask on test')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Input device'), { target: { value: 'mic-b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test microphone' }));

    await waitFor(() =>
      expect(mocks.capture).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: 'mic-b', onLevel: expect.any(Function) }),
      ),
    );
    expect(await screen.findByText(/Microphone passed/i)).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByLabelText('Play microphone test recording')).toBeTruthy();
  });

  it.each([
    ['silent', 'No speech detected'],
    ['noisy', 'Background noise is too loud'],
  ] as const)('shows a clear failure for %s input', async (verdict, copy) => {
    mocks.capture.mockResolvedValue({
      verdict,
      passed: false,
      peakLevel: verdict === 'silent' ? 0.005 : 0.6,
      averageLevel: verdict === 'silent' ? 0.002 : 0.56,
      recording: null,
    });
    render(<MicrophoneTestPanel />);
    await screen.findByText('Permission: Ask on test');
    fireEvent.click(screen.getByRole('button', { name: 'Test microphone' }));
    expect(await screen.findByText(new RegExp(copy, 'i'))).toBeTruthy();
  });

  it('reports denied permission and no-device states', async () => {
    mocks.permission.mockResolvedValue('denied');
    mocks.list.mockResolvedValue([]);
    render(<MicrophoneTestPanel />);

    expect(await screen.findByText('Permission: Denied')).toBeTruthy();
    expect(screen.getByText('No microphone detected')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Test microphone' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
