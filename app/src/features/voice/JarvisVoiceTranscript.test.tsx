import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types';
import { JarvisVoiceTranscript } from './JarvisVoiceTranscript';

function message(id: string, role: 'user' | 'assistant', text: string): Message {
  return {
    id: id as Message['id'],
    chat_id: 'chat-voice' as Message['chat_id'],
    role,
    parts: [{ kind: 'text', text }],
    created_at: 1,
    updated_at: 1,
  };
}

describe('JarvisVoiceTranscript accessibility', () => {
  it('keeps committed and interim text readable without live-announcing every mutation', () => {
    const longUserMessage =
      'A deliberately long voice request that must remain readable when text is scaled and must expose an accessible expansion control without relying on accent color.';
    render(
      <JarvisVoiceTranscript
        messages={[
          message('message-1', 'assistant', 'Stable committed reply'),
          message('message-2', 'user', longUserMessage),
        ]}
        partial="rapidly changing interim words"
        hasBoundChat
        expandedIds={new Set()}
        onToggleExpanded={vi.fn()}
      />,
    );

    const transcript = screen.getByRole('log', { name: 'Voice session transcript' });
    expect(transcript.getAttribute('aria-live')).toBe('off');
    expect(screen.getByText('Stable committed reply')).toBeTruthy();
    const interim = screen.getByText('rapidly changing interim words');
    expect(interim).toBeTruthy();
    expect(interim.getAttribute('data-live-announcement')).toBe('off');

    expect(screen.getByText('Jarvis').classList.contains('text-foreground')).toBe(true);
    expect(
      screen.getAllByText('You').every((label) => label.classList.contains('text-foreground')),
    ).toBe(true);
    expect(
      screen.getByText('Stable committed reply').closest('.grid')?.classList.contains('text-xs'),
    ).toBe(true);
    expect(
      screen
        .getByText('Stable committed reply')
        .closest('.grid')
        ?.classList.contains('grid-cols-[1.5rem_2.75rem_minmax(0,1fr)_auto]'),
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Show more' }).classList.contains('text-foreground'),
    ).toBe(true);
  });
});
