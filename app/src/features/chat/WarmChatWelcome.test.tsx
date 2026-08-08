import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WarmChatWelcome } from './WarmChatWelcome';

const hookState = vi.hoisted(() => ({ messages: [] as Array<{ id: string }> }));
const uiState = vi.hoisted(() => ({ theme: 'warm' }));
const welcomeCss = readFileSync(resolve(__dirname, 'chat-welcome.css'), 'utf8');

vi.mock('./hooks', () => ({
  useChatMessages: () => hookState.messages,
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: { theme: string }) => unknown) => selector(uiState),
}));

describe('WarmChatWelcome', () => {
  afterEach(() => {
    cleanup();
    hookState.messages = [];
    uiState.theme = 'warm';
  });

  it('renders the approved empty-chat copy and four keyboard-accessible prompt choices', () => {
    render(<WarmChatWelcome chatId="chat-1" />);

    expect(screen.getByRole('heading', { name: 'Start a conversation' })).not.toBeNull();
    expect(
      screen.getByText('Ask anything, explore ideas, or delegate to an agent.'),
    ).not.toBeNull();
    expect(
      screen.getByRole('img', { name: 'Notebook, coffee, and writing tools' }).getAttribute('src'),
    ).toBe('/assets/themes/warm/reference/chat-notebook.png');
    expect(screen.getAllByRole('button')).toHaveLength(4);
    for (const label of [
      'Ask Jarvis anything',
      'Plan a project',
      'Review my code',
      'Research a topic',
    ]) {
      expect(
        (screen.getByRole('button', { name: new RegExp(label, 'i') }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    }
    expect(screen.queryByText('Jarvis session')).toBeNull();
  });

  it('inserts the selected prompt through the existing composer event and targets this chat', () => {
    const listener = vi.fn();
    window.addEventListener('jarvis:composer:insert-text', listener);
    render(<WarmChatWelcome chatId="chat-42" />);

    fireEvent.click(screen.getByRole('button', { name: /plan a project/i }));

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0] as CustomEvent<{
      chatId: string;
      text: string;
      skillId: string;
    }>;
    expect(event.detail).toEqual({
      chatId: 'chat-42',
      text: 'Plan a project',
      skillId: 'analyze',
    });
    window.removeEventListener('jarvis:composer:insert-text', listener);
  });

  it('attaches the matching real catalog skill for every quick action', () => {
    const listener = vi.fn();
    window.addEventListener('jarvis:composer:insert-text', listener);
    render(<WarmChatWelcome chatId="chat-skills" />);

    const expected = new Map([
      ['Ask Jarvis anything', 'analyze'],
      ['Plan a project', 'analyze'],
      ['Review my code', 'build'],
      ['Research a topic', 'research'],
    ]);
    for (const [label] of expected) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(label, 'i') }));
    }

    expect(listener).toHaveBeenCalledTimes(4);
    listener.mock.calls.forEach(([rawEvent], index) => {
      const event = rawEvent as CustomEvent<{ skillId: string }>;
      expect(event.detail.skillId).toBe([...expected.values()][index]);
    });
    window.removeEventListener('jarvis:composer:insert-text', listener);
  });

  it('leaves populated chats untouched', () => {
    hookState.messages = [{ id: 'message-1' }];
    const { container } = render(<WarmChatWelcome chatId="chat-1" />);

    expect(container.innerHTML).toBe('');
  });

  it('marks compact pet welcome for panel scaling and still shows four starters', () => {
    const { container } = render(<WarmChatWelcome chatId="chat-pet" compact />);
    const section = container.querySelector('[data-pet-chat-welcome="true"]');
    expect(section).not.toBeNull();
    expect(section?.className).toContain('warm-chat-welcome--compact');
    expect(screen.getAllByRole('button')).toHaveLength(4);
    expect(screen.getByRole('img', { name: 'Notebook, coffee, and writing tools' })).not.toBeNull();
  });

  it.each([
    ['default', '/assets/themes/default/chat-welcome.webp', /open notebook/i],
    ['monochrome', '/assets/themes/monochrome/chat-welcome.webp', /monochrome paper/i],
    ['jarvis', '/assets/themes/jarvis/chat-welcome.webp', /jarvis listening notebook/i],
  ])('uses dedicated %s welcome artwork', (theme, expectedSrc, expectedAlt) => {
    uiState.theme = theme;
    render(<WarmChatWelcome chatId={`chat-${theme}`} />);

    expect(screen.getByRole('img', { name: expectedAlt }).getAttribute('src')).toBe(expectedSrc);
  });

  it('blends every non-Warm illustration into its own theme surface', () => {
    for (const theme of ['default', 'jarvis', 'monochrome']) {
      expect(welcomeCss).toMatch(
        new RegExp(`\\[data-chat-welcome-theme='${theme}'\\]\\s+\\.warm-chat-welcome__art`, 'u'),
      );
    }
    expect(welcomeCss).toMatch(
      /\.warm-chat-welcome__art\s*\{[\s\S]*?mask-image:\s*radial-gradient\([\s\S]*?transparent\s+88%\s*\)/u,
    );
    expect(welcomeCss).toMatch(
      /\[data-chat-welcome-theme='monochrome'\]\s+\.warm-chat-welcome__art\s*\{[\s\S]*?grayscale\(1\)/u,
    );
  });
});
