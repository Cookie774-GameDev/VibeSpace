import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepgramCredentialCard } from './DeepgramCredentialCard';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  test: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/lib/deepgram', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/deepgram')>();
  return {
    ...actual,
    loadDeepgramCredential: mocks.load,
    saveDeepgramCredential: mocks.save,
    testDeepgramCredential: mocks.test,
    removeDeepgramCredential: mocks.remove,
  };
});

describe('DeepgramCredentialCard', () => {
  beforeEach(() => {
    mocks.load.mockReset().mockResolvedValue({ configured: false, health: 'missing' });
    mocks.save.mockReset();
    mocks.test.mockReset().mockResolvedValue({ configured: true, health: 'connected' });
    mocks.remove.mockReset();
  });

  it('does not render a credential value when an existing key is connected', async () => {
    mocks.load.mockResolvedValue({
      configured: true,
      health: 'connected',
      projectName: 'Voice Project',
      checkedAt: '2026-08-02T19:00:00Z',
    });
    mocks.test.mockResolvedValue({
      configured: true,
      health: 'connected',
      projectName: 'Voice Project',
      checkedAt: '2026-08-02T19:00:00Z',
    });

    render(<DeepgramCredentialCard />);

    expect(screen.getByRole('img', { name: 'Deepgram' })).toBeTruthy();
    expect(document.querySelector('.jarvis-deepgram-credential-card img')).toBeNull();
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.getByText('Voice Project')).toBeTruthy();
    expect(screen.queryByLabelText('Deepgram API key')).toBeNull();
    expect(document.body.textContent).not.toContain('secret');
  });

  it('validates and stores a new key, clears the draft, and switches to connected state', async () => {
    mocks.save.mockResolvedValue({
      configured: true,
      health: 'connected',
      projectName: 'VibeSpace',
      checkedAt: '2026-08-02T19:00:00Z',
    });
    render(<DeepgramCredentialCard />);

    const input = await screen.findByLabelText('Deepgram API key');
    fireEvent.change(input, { target: { value: 'dg-private-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Deepgram' }));

    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith('dg-private-key'));
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.queryByDisplayValue('dg-private-key')).toBeNull();
    expect(document.body.textContent).not.toContain('dg-private-key');
  });

  it('supports test, replace, invalid recovery, and removal without revealing a stored key', async () => {
    mocks.load.mockResolvedValue({ configured: true, health: 'unknown' });
    mocks.test.mockResolvedValue({
      configured: true,
      health: 'invalid',
      errorCode: 'invalid_key',
    });
    mocks.remove.mockResolvedValue({ configured: false, health: 'missing' });
    render(<DeepgramCredentialCard />);

    expect(await screen.findByText(/invalid or revoked/i)).toBeTruthy();
    expect(mocks.test).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Test Deepgram' }));
    await waitFor(() => expect(mocks.test).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: 'Replace Deepgram key' }));
    expect(screen.getByLabelText('Deepgram API key')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Deepgram key' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'Connect Deepgram' })).toBeTruthy();
  });
});
