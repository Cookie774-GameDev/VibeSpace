import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CallAnyonePanel } from './CallAnyonePanel';

describe('Call Anyone approval flow', () => {
  function completeRecipientStep(phone = '+1 312 555 0192') {
    fireEvent.change(screen.getByLabelText('Recipient phone number'), {
      target: { value: phone },
    });
    fireEvent.change(screen.getByLabelText('Recipient name'), {
      target: { value: "Mario's Pizza" },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to call brief' }));
  }

  it('prepares a review card without starting the call', async () => {
    const prepare = vi.fn().mockResolvedValue({
      id: 'job-1',
      status: 'awaiting_user_approval',
      destinationDisplayName: "Mario's Pizza",
      destinationMasked: '+* (***) ***-0192',
      purpose: 'Ask when the restaurant closes.',
      openingDisclosure: 'Hello, I am the VibeSpace AI assistant.',
      approvedScript: 'Ask for today’s closing time.',
      allowedActions: ['ask_questions'],
      maximumDurationSeconds: 300,
      maximumCreditReservation: 480,
    });
    const approve = vi.fn();
    const start = vi.fn();
    render(
      <CallAnyonePanel
        client={{
          prepare,
          approve,
          start,
          get: vi.fn(),
          cancel: vi.fn(),
          approveLive: vi.fn(),
          declineLive: vi.fn(),
          saveContact: vi.fn().mockResolvedValue({ id: 'contact-1' }),
        }}
      />,
    );

    completeRecipientStep();
    fireEvent.change(screen.getByLabelText('Purpose'), {
      target: { value: 'Ask when the restaurant closes.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review call' }));

    expect(
      await screen.findByText(
        (_text, element) =>
          element?.tagName === 'DD' && Boolean(element.textContent?.includes('***-0192')),
      ),
    ).not.toBeNull();
    expect(prepare).toHaveBeenCalledOnce();
    expect(approve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByText(/Up to 480 shared credits may be reserved/)).not.toBeNull();
  });

  it('starts only after explicit approval', async () => {
    const prepared = {
      id: 'job-1',
      status: 'awaiting_user_approval',
      destinationDisplayName: 'Clinic',
      destinationMasked: '+* (***) ***-0110',
      purpose: 'Ask about office hours.',
      openingDisclosure: 'Hello, I am the VibeSpace AI assistant.',
      approvedScript: 'Ask about office hours.',
      allowedActions: ['ask_questions'],
      maximumDurationSeconds: 300,
      maximumCreditReservation: 480,
    };
    const client = {
      prepare: vi.fn().mockResolvedValue(prepared),
      approve: vi.fn().mockResolvedValue({ ...prepared, status: 'approved' }),
      start: vi.fn().mockResolvedValue({ ...prepared, status: 'queued' }),
      get: vi.fn(),
      cancel: vi.fn(),
      approveLive: vi.fn(),
      declineLive: vi.fn(),
      saveContact: vi.fn().mockResolvedValue({ id: 'contact-1' }),
    };
    render(<CallAnyonePanel client={client} />);

    fireEvent.change(screen.getByLabelText('Recipient phone number'), {
      target: { value: '+13125550110' },
    });
    fireEvent.change(screen.getByLabelText('Recipient name'), {
      target: { value: 'Clinic' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to call brief' }));
    fireEvent.change(screen.getByLabelText('Purpose'), {
      target: { value: 'Ask about office hours.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review call' }));
    await screen.findByText(
      (_text, element) =>
        element?.tagName === 'DD' && Boolean(element.textContent?.includes('***-0110')),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve and call' }));

    await waitFor(() => expect(client.start).toHaveBeenCalledWith('job-1'));
    expect(client.approve).toHaveBeenCalledWith('job-1');
    expect(screen.getByText('Call queued')).not.toBeNull();
  });

  it('blocks invalid numbers before any server or contact request', async () => {
    const client = {
      prepare: vi.fn(),
      approve: vi.fn(),
      start: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn(),
      approveLive: vi.fn(),
      declineLive: vi.fn(),
      saveContact: vi.fn(),
    };
    render(<CallAnyonePanel client={client} />);

    completeRecipientStep('911');

    expect(screen.getByRole('alert').textContent).toContain('country code');
    expect(client.saveContact).not.toHaveBeenCalled();
    expect(client.prepare).not.toHaveBeenCalled();
  });

  it('shows credit exhaustion with the real available balance and allows cancellation', async () => {
    const prepared = {
      id: 'job-2',
      status: 'awaiting_user_approval',
      destinationDisplayName: "Mario's Pizza",
      destinationMasked: '+* (***) ***-0192',
      purpose: 'Ask when the restaurant closes.',
      openingDisclosure: 'Hello, I am the VibeSpace AI assistant.',
      allowedActions: ['ask_questions'],
      maximumDurationSeconds: 300,
      maximumCreditReservation: 480,
    };
    const client = {
      prepare: vi.fn().mockResolvedValue(prepared),
      approve: vi.fn().mockResolvedValue({ ...prepared, status: 'approved' }),
      start: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('budget_exceeded'), { availableCredits: 125 })),
      get: vi.fn(),
      cancel: vi.fn().mockResolvedValue({ ...prepared, status: 'cancelled' }),
      approveLive: vi.fn(),
      declineLive: vi.fn(),
      saveContact: vi.fn().mockResolvedValue({ id: 'contact-1' }),
    };
    render(<CallAnyonePanel client={client} />);

    completeRecipientStep();
    fireEvent.change(screen.getByLabelText('Purpose'), {
      target: { value: 'Ask when the restaurant closes.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review call' }));
    await screen.findByText(/Up to 480 shared credits/);
    fireEvent.click(screen.getByRole('button', { name: 'Approve and call' }));
    expect((await screen.findByRole('alert')).textContent).toContain('125 credits');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(client.cancel).toHaveBeenCalledWith('job-2'));
  });

  it('blocks outbound setup when the hosted call provider is unavailable', () => {
    render(
      <CallAnyonePanel
        availability={{
          ready: false,
          message:
            'The hosted call provider is not ready. Open System readiness above for the exact configuration issue.',
        }}
      />,
    );

    expect(screen.getByText(/hosted call provider is not ready/i)).not.toBeNull();
    expect(
      (
        screen.getByRole('button', {
          name: /continue to call brief/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('saves optional contact context and shows account-scoped recent call history', async () => {
    const client = {
      prepare: vi.fn().mockResolvedValue({
        id: 'job-new',
        status: 'awaiting_user_approval',
        destinationDisplayName: 'Sam',
        destinationMasked: '+* (***) ***-0192',
        purpose: 'Share an update.',
        openingDisclosure: 'Hello, I am the VibeSpace AI assistant.',
        allowedActions: ['ask_questions'],
        maximumDurationSeconds: 300,
        maximumCreditReservation: 480,
      }),
      approve: vi.fn(),
      start: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn(),
      approveLive: vi.fn(),
      declineLive: vi.fn(),
      saveContact: vi.fn().mockResolvedValue({ id: 'contact-1' }),
      listContacts: vi.fn().mockResolvedValue([
        {
          id: 'contact-1',
          displayName: 'Sam',
          destinationType: 'saved_contact',
          destinationMasked: '+* (***) ***-0192',
          relationship: 'Friend',
          notes: 'Prefers afternoon calls.',
          profileImageUrl: 'https://images.example/sam.png',
        },
      ]),
      listHistory: vi.fn().mockResolvedValue([
        {
          id: 'job-old',
          status: 'completed',
          destinationDisplayName: 'Sam',
          destinationMasked: '+* (***) ***-0192',
          resultSummary: 'Update delivered.',
          settledCredits: 42,
          createdAt: '2026-08-03T04:00:00.000Z',
        },
      ]),
    };

    render(<CallAnyonePanel client={client} />);
    expect(await screen.findByText('Update delivered.')).not.toBeNull();
    expect(screen.getByText('Friend')).not.toBeNull();
    expect(document.querySelector('img[src="https://images.example/sam.png"]')).not.toBeNull();

    fireEvent.change(screen.getByLabelText('Recipient phone number'), {
      target: { value: '+13125550192' },
    });
    fireEvent.change(screen.getByLabelText('Recipient name'), { target: { value: 'Sam' } });
    fireEvent.change(screen.getByLabelText('Relationship (optional)'), {
      target: { value: 'Friend' },
    });
    fireEvent.change(screen.getByLabelText('Profile image URL (optional)'), {
      target: { value: 'https://images.example/sam.png' },
    });
    fireEvent.change(screen.getByLabelText('Contact notes (optional)'), {
      target: { value: 'Prefers afternoon calls.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to call brief' }));
    fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: 'Share an update.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review call' }));

    await waitFor(() =>
      expect(client.saveContact).toHaveBeenCalledWith(
        expect.objectContaining({
          relationship: 'Friend',
          notes: 'Prefers afternoon calls.',
          profileImageUrl: 'https://images.example/sam.png',
        }),
      ),
    );
  });
});
